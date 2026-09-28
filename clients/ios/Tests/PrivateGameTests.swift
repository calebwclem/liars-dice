import XCTest
@testable import LiarsDice

/// Private games from the client's side, against a stubbed server.
///
/// The server's own tests prove a code gets two players into one match. These prove the half a
/// player actually touches: that a typed code is cleaned up before it is sent, that the stages
/// move the way the screens expect, and that a refusal is surfaced rather than swallowed.
@MainActor
final class PrivateGameTests: XCTestCase {
    private func session(_ transport: StubTransport) -> GameSession {
        GameSession(
            endpoint: URL(string: "ws://stub")!,
            tokens: InMemoryTokenStore(token: nil),
            makeTransport: { _ in transport }
        )
    }

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

    /// Connect and get to the lobby, which every private-game path starts from.
    private func connected(_ transport: StubTransport, as playerId: String) async throws -> GameSession {
        let session = self.session(transport)
        await session.connect()
        try await transport.push(
            ServerMessage.welcome(.init(protocolVersion: protocolVersion, playerId: playerId, token: "tok"))
        )
        try await waitUntil("the lobby") { session.stage == .lobby }
        return session
    }

    private func party(
        code: String = "WXYZ",
        host: String,
        members: [String]
    ) -> ServerMessage {
        .partyState(.init(code: code, hostId: host, members: members, minSize: 2, maxSize: 6))
    }

    // MARK: - Normalising what a player typed

    func testATypedCodeIsCleanedUpBeforeItIsSent() {
        // The wire contract is strict and uppercase. Everything a person might plausibly do to a
        // four-character code — lowercase it, paste it with a space, add a stray hyphen — has to
        // survive, because being told "bad message" for typing lowercase is indefensible.
        XCTAssertEqual(GameSession.normalise("wxyz"), "WXYZ")
        XCTAssertEqual(GameSession.normalise("w x y z"), "WXYZ")
        XCTAssertEqual(GameSession.normalise("WX-YZ"), "WXYZ")
        XCTAssertEqual(GameSession.normalise("  wxyz  "), "WXYZ")
    }

    func testCharactersOutsideTheAlphabetAreDroppedRatherThanSent() {
        // O/0 and I/1 are not in the alphabet precisely because they are misheard, so a player
        // reading a code aloud cannot produce them. Dropping is better than substituting: a
        // guess about what they meant would silently join the wrong game.
        XCTAssertEqual(GameSession.normalise("W0XI"), "WX")
        XCTAssertFalse(GameSession.isCompleteCode("W0XI"))
        XCTAssertFalse(GameSession.isCompleteCode("WXY"))
        XCTAssertTrue(GameSession.isCompleteCode("wxyz"))
    }

    func testOverlongInputIsTruncatedToACode() {
        XCTAssertEqual(GameSession.normalise("WXYZABCD"), "WXYZ")
    }

    func testJoiningSendsTheNormalisedCode() async throws {
        let transport = StubTransport()
        let session = try await connected(transport, as: "me")

        session.joinParty(code: "w x y z")
        try await waitUntil("the join to be written") {
            let frames = await transport.writtenFrames()
            return frames.contains { $0.contains("\"type\":\"joinParty\"") }
        }
        let frames = await transport.writtenFrames()
        let join = try XCTUnwrap(frames.last { $0.contains("joinParty") })
        XCTAssertTrue(join.contains("\"code\":\"WXYZ\""), "sent \(join)")
    }

    // MARK: - Stages

    func testCreatingAPartyLandsOnThePrivateGameScreen() async throws {
        let transport = StubTransport()
        let session = try await connected(transport, as: "me")

        session.createParty()
        try await transport.push(party(host: "me", members: ["me"]))
        try await waitUntil("the party screen") {
            if case .party = session.stage { return true }
            return false
        }
        guard case .party(let state) = session.stage else { return XCTFail("not in a party") }
        XCTAssertEqual(state.code, "WXYZ")
        XCTAssertEqual(state.hostId, "me")
        XCTAssertEqual(state.members, ["me"])
    }

    func testTheScreenFollowsPeopleArrivingAndLeaving() async throws {
        let transport = StubTransport()
        let session = try await connected(transport, as: "me")
        session.createParty()

        try await transport.push(party(host: "me", members: ["me"]))
        try await transport.push(party(host: "me", members: ["me", "them"]))
        try await waitUntil("the second member") {
            if case .party(let state) = session.stage { return state.members.count == 2 }
            return false
        }

        // And the host passing on when the original host drops — the client just renders whatever
        // the server says, which is the point: no local idea of who the host is to go stale.
        try await transport.push(party(host: "them", members: ["them"]))
        try await waitUntil("the new host") {
            if case .party(let state) = session.stage { return state.hostId == "them" }
            return false
        }
    }

    func testLeavingAPartyGoesBackToTheLobby() async throws {
        let transport = StubTransport()
        let session = try await connected(transport, as: "me")
        session.createParty()
        try await transport.push(party(host: "me", members: ["me"]))
        try await waitUntil("the party screen") {
            if case .party = session.stage { return true }
            return false
        }

        session.leaveParty()
        try await transport.push(ServerMessage.partyLeft)
        try await waitUntil("the lobby") { session.stage == .lobby }
    }

    func testStartingTheMatchSendsTheBotChoice() async throws {
        let transport = StubTransport()
        let session = try await connected(transport, as: "me")
        session.createParty()
        try await transport.push(party(host: "me", members: ["me", "them"]))
        try await waitUntil("the party screen") {
            if case .party = session.stage { return true }
            return false
        }

        session.startParty(fillWithBots: true)
        try await waitUntil("the start to be written") {
            let frames = await transport.writtenFrames()
            return frames.contains { $0.contains("\"type\":\"startParty\"") }
        }
        let frames = await transport.writtenFrames()
        let start = try XCTUnwrap(frames.last { $0.contains("startParty") })
        XCTAssertTrue(start.contains("\"fillWithBots\":true"), "sent \(start)")
    }

    func testAPartyBecomesAMatchWhenTheServerSaysSo() async throws {
        let transport = StubTransport()
        let session = try await connected(transport, as: "me")
        session.createParty()
        try await transport.push(party(host: "me", members: ["me", "them"]))
        try await waitUntil("the party screen") {
            if case .party = session.stage { return true }
            return false
        }

        try await transport.push(
            ServerMessage.matchFound(
                .init(
                    matchId: "m1",
                    seats: [
                        SeatStatus(playerId: "me", seat: 0, connected: true, control: .human, controlReason: nil),
                        SeatStatus(playerId: "them", seat: 1, connected: true, control: .human, controlReason: nil),
                    ]
                )
            )
        )
        try await waitUntil("the match") { session.stage == .playing }
        XCTAssertEqual(session.match?.matchId, "m1")
    }

    // MARK: - Refusals

    func testABadCodeIsShownRatherThanSwallowed() async throws {
        let transport = StubTransport()
        let session = try await connected(transport, as: "me")

        session.joinParty(code: "ZZZZ")
        try await transport.push(ServerMessage.error(.init(code: .unknownParty, detail: nil)))
        try await waitUntil("the refusal") { session.lastError == .unknownParty }

        // Still in the lobby: a refused join must not move the player anywhere.
        XCTAssertEqual(session.stage, .lobby)
        XCTAssertFalse(session.lastError?.readable.contains("_") ?? true, "shows a raw code")
    }

    func testEveryPrivateGameRefusalHasSomethingReadableToSay() {
        for code in [
            ErrorCode.unknownParty, .partyFull, .alreadyInParty,
            .notInParty, .notPartyHost, .partyTooSmall,
        ] {
            XCTAssertFalse(code.readable.isEmpty, "\(code) has no copy")
            XCTAssertFalse(code.readable.contains("_"), "\(code) shows a raw reason code")
        }
    }
}
