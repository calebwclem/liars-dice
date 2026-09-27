import XCTest
@testable import LiarsDice

/// The whole client, end to end, against a stubbed server.
///
/// PLAN.md's Phase 3 is done when the app goes queue → match → bid → challenge → reveal → win
/// screen. This drives that path with a real `GameSession`, a real `GameSocket` and a real
/// `MatchViewModel`, replaying a transcript captured from an actual `Room` by `pnpm fixtures`.
/// The only stub is the socket itself.
@MainActor
final class SessionFlowTests: XCTestCase {
    private struct Transcript: Decodable {
        let playerId: String
        let winnerId: String?
        let messages: [ServerMessage]
    }

    /// Hands out a scripted transport per connection attempt, so a reconnect can be scripted too.
    private final class TransportQueue: @unchecked Sendable {
        private let lock = NSLock()
        private var transports: [StubTransport]
        private(set) var handedOut: [StubTransport] = []

        init(_ transports: [StubTransport]) {
            self.transports = transports
        }

        func next() -> StubTransport {
            lock.lock()
            defer { lock.unlock() }
            let transport = transports.isEmpty ? StubTransport() : transports.removeFirst()
            handedOut.append(transport)
            return transport
        }

        /// How many connections have been opened. Locked, since the session opens them from a
        /// different task than the one asserting about them.
        var connections: Int {
            lock.lock()
            defer { lock.unlock() }
            return handedOut.count
        }
    }

    private func loadTranscript() throws -> Transcript {
        let bundle = Bundle(for: Self.self)
        let url = try XCTUnwrap(
            bundle.url(forResource: "transcript", withExtension: "json"),
            "run `pnpm fixtures`"
        )
        return try JSONDecoder().decode(Transcript.self, from: Data(contentsOf: url))
    }

    private func makeSession(
        _ queue: TransportQueue,
        token: String? = nil
    ) -> GameSession {
        GameSession(
            endpoint: URL(string: "ws://stub")!,
            tokens: InMemoryTokenStore(token: token),
            makeTransport: { _ in queue.next() }
        )
    }

    /// Poll until a condition holds, or fail saying what we were waiting for. The session is
    /// driven by async message delivery, so there is nothing to await directly.
    private func waitUntil(
        _ what: String,
        timeout: TimeInterval = 5,
        _ ready: @MainActor () async -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await ready() { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("timed out waiting for \(what)")
    }

    /// True when the client has written a frame of this type.
    private func hasSent(_ type: String, on transport: StubTransport) async -> Bool {
        let frames = await transport.writtenFrames()
        return frames.contains { $0.contains("\"type\":\"\(type)\"") }
    }

    // MARK: - The path PLAN.md asks for

    func testQueueThroughToTheWinScreen() async throws {
        let transcript = try loadTranscript()
        let transport = StubTransport()
        let queue = TransportQueue([transport])
        let session = makeSession(queue)

        await session.connect()

        // The client introduces itself before anything else, with the protocol version the
        // server gates on.
        let opening = try await transport.writtenMessages()
        guard case .hello(let hello) = opening.first else { return XCTFail("expected a hello") }
        XCTAssertEqual(hello.protocolVersion, protocolVersion)
        XCTAssertNil(hello.token, "a first-run client has no token yet")

        try await transport.push(
            ServerMessage.welcome(.init(protocolVersion: 1, playerId: transcript.playerId, token: "tok"))
        )
        try await waitUntil("the lobby") { session.stage == .lobby }
        XCTAssertEqual(session.playerId, transcript.playerId)

        // Queue up.
        session.findMatch()
        try await transport.push(ServerMessage.queued(.init(waiting: 2, target: 4, backfillInMs: 9_000)))
        try await waitUntil("the queue screen") {
            session.stage == .queued(waiting: 2, target: 4, backfillInMs: 9_000)
        }

        // Then replay the match exactly as the server played it.
        for message in transcript.messages {
            try await transport.push(message)
        }
        try await waitUntil("the match to finish", timeout: 20) {
            session.match?.winnerId != nil
        }

        let match = try XCTUnwrap(session.match)
        XCTAssertEqual(session.stage, .playing)
        XCTAssertEqual(match.winnerId, transcript.winnerId)
        XCTAssertEqual(match.iWon, transcript.winnerId == transcript.playerId)

        // The whole match really did pass through the client: bids, a reveal, an elimination.
        let seen = Set(match.log.map(\.type))
        XCTAssertTrue(seen.contains("bidMade"))
        XCTAssertTrue(seen.contains("diceRevealed"))
        XCTAssertTrue(seen.contains("dieLost"))
        XCTAssertTrue(seen.contains("matchEnded"))
        XCTAssertGreaterThan(match.roundNumber, 1)

        // And the client only ever held its own dice.
        XCTAssertEqual(match.view?.you?.id, transcript.playerId)
        session.disconnect()
    }

    func testTheClientBidsWhenItIsItsTurnAndTheServerSeesIt() async throws {
        let transport = StubTransport()
        let session = makeSession(TransportQueue([transport]))
        await session.connect()
        try await transport.push(ServerMessage.welcome(.init(protocolVersion: 1, playerId: "me", token: "t")))
        try await waitUntil("the lobby") { session.stage == .lobby }

        try await transport.push(
            ServerMessage.matchFound(.init(matchId: "m1", seats: [
                SeatStatus(playerId: "me", seat: 0, connected: true, control: .human, controlReason: nil),
                SeatStatus(playerId: "them", seat: 1, connected: true, control: .human, controlReason: nil),
            ]))
        )
        try await waitUntil("the table") { session.match != nil }

        // A snapshot where it is our turn, with the server's own answer about what is biddable.
        try await transport.push(turnSnapshot(seq: 1))
        try await waitUntil("our turn") { session.match?.isMyTurn == true }

        let match = try XCTUnwrap(session.match)
        XCTAssertEqual(match.biddableFaces, [.four, .five, .six])
        match.choose(face: .five)
        match.submitBid()

        try await waitUntil("the bid to be sent") { await self.hasSent("bid", on: transport) }
        let written = try await transport.writtenMessages()
        guard case .bid(let bid) = written.last else { return XCTFail("expected a bid") }
        XCTAssertEqual(bid.matchId, "m1")
        XCTAssertEqual(bid.bid.face, .five)
        XCTAssertGreaterThanOrEqual(bid.bid.quantity, 3, "at least the server's minimum")

        session.disconnect()
    }

    /// R-18: the socket drops, the client comes back with its token and asks for a resync.
    func testADroppedSocketReconnectsAndResumes() async throws {
        let first = StubTransport()
        let second = StubTransport()
        let queue = TransportQueue([first, second])
        let session = makeSession(queue)

        await session.connect()
        try await first.push(ServerMessage.welcome(.init(protocolVersion: 1, playerId: "me", token: "tok-1")))
        try await waitUntil("the lobby") { session.stage == .lobby }
        try await first.push(
            ServerMessage.matchFound(.init(matchId: "m1", seats: [
                SeatStatus(playerId: "me", seat: 0, connected: true, control: .human, controlReason: nil),
            ]))
        )
        try await first.push(turnSnapshot(seq: 7))
        try await waitUntil("a snapshot") { session.match?.lastSeq == 7 }

        // The connection dies without warning.
        await first.finish()
        try await waitUntil("a reconnect attempt") { queue.connections == 2 }
        XCTAssertTrue(session.reconnecting)

        // The second connection presents the stored token, so the server can recognise the seat.
        try await waitUntil("a second hello") { await self.hasSent("hello", on: second) }
        let reopened = try await second.writtenMessages()
        guard case .hello(let hello) = reopened.first else { return XCTFail("expected a hello") }
        XCTAssertEqual(hello.token, "tok-1", "the token from the first connection")

        // The server welcomes them back and the client asks for everything after the last seq it
        // saw — R-18's "the client requests a full resync".
        try await second.push(ServerMessage.welcome(.init(protocolVersion: 1, playerId: "me", token: "tok-1")))
        try await waitUntil("a resume") { await self.hasSent("resume", on: second) }
        let afterWelcome = try await second.writtenMessages()
        guard case .resume(let resume) = afterWelcome.last else { return XCTFail("expected a resume") }
        XCTAssertEqual(resume.matchId, "m1")
        XCTAssertEqual(resume.afterSeq, 7)
        XCTAssertFalse(session.reconnecting)

        session.disconnect()
    }

    func testAnOldClientIsToldToUpdateRatherThanLeftGuessing() async throws {
        let transport = StubTransport()
        let session = makeSession(TransportQueue([transport]))
        await session.connect()
        try await transport.push(
            ServerMessage.updateRequired(
                .init(serverProtocolVersion: 99, minProtocolVersion: 99, message: "please update")
            )
        )
        try await waitUntil("the update screen") {
            session.stage == .needsUpdate(serverVersion: 99)
        }
        session.disconnect()
    }

    func testARefusedActionIsSurfacedToThePlayer() async throws {
        let transport = StubTransport()
        let session = makeSession(TransportQueue([transport]))
        await session.connect()
        try await transport.push(ServerMessage.welcome(.init(protocolVersion: 1, playerId: "me", token: "t")))
        try await waitUntil("the lobby") { session.stage == .lobby }

        try await transport.push(ServerMessage.error(.init(code: .bidTooLow, detail: nil)))
        try await waitUntil("the error") { session.lastError == .bidTooLow }
        XCTAssertFalse(ErrorCode.bidTooLow.readable.isEmpty)
        session.disconnect()
    }

    // MARK: - Builders

    private func turnSnapshot(seq: Int) -> ServerMessage {
        .state(
            .init(
                kind: .update,
                matchId: "m1",
                seq: seq,
                events: [.bidMade(.init(playerId: "them", bid: Bid(quantity: 2, face: .four)))],
                snapshot: MatchSnapshot(
                    view: PlayerView(
                        matchId: "m1",
                        seq: seq,
                        config: MatchConfig(startingDice: 5, maxDice: 5),
                        you: PlayerView.You(id: "me", seat: 0, dice: [.five, .five, .two, .six, .one]),
                        players: [
                            PublicPlayer(id: "me", seat: 0, diceCount: 5, eliminated: false),
                            PublicPlayer(id: "them", seat: 1, diceCount: 5, eliminated: false),
                        ],
                        phase: .bidding(.init(turnId: "me")),
                        round: PlayerView.Round(
                            index: 0,
                            starterId: "them",
                            bids: [BidRecord(playerId: "them", bid: Bid(quantity: 2, face: .four))]
                        ),
                        lastReveal: nil,
                        totalDiceInPlay: 10
                    ),
                    turnEndsInMs: 30_000,
                    turnMs: 30_000,
                    seats: [
                        SeatStatus(playerId: "me", seat: 0, connected: true, control: .human, controlReason: nil),
                        SeatStatus(playerId: "them", seat: 1, connected: true, control: .human, controlReason: nil),
                    ],
                    bidOptions: BidOptions(
                        options: [
                            BidOption(face: .one, minQuantity: nil),
                            BidOption(face: .two, minQuantity: nil),
                            BidOption(face: .three, minQuantity: nil),
                            BidOption(face: .four, minQuantity: 3),
                            BidOption(face: .five, minQuantity: 3),
                            BidOption(face: .six, minQuantity: 3),
                        ],
                        maxQuantity: 10
                    )
                )
            )
        )
    }
}
