import XCTest
@testable import LiarsDice

/// The socket actor, against a stubbed transport.
final class GameSocketTests: XCTestCase {
    private func welcome(token: String = "t") -> ServerMessage {
        .welcome(.init(protocolVersion: 1, playerId: "p1", token: token))
    }

    func testDecodedMessagesArriveOnTheStreamInOrder() async throws {
        let transport = StubTransport()
        let socket = GameSocket(transport: transport)
        let stream = try await socket.connect()

        try await transport.push(welcome())
        try await transport.push(ServerMessage.pong)
        try await transport.push(
            ServerMessage.queued(.init(waiting: 2, target: 4, backfillInMs: 8_000))
        )

        var received: [ServerMessage] = []
        for await message in stream {
            received.append(message)
            if received.count == 3 { break }
        }

        XCTAssertEqual(received.count, 3)
        guard case .welcome(let first) = received[0] else { return XCTFail("expected welcome") }
        XCTAssertEqual(first.playerId, "p1")
        XCTAssertEqual(received[1], .pong)
        guard case .queued(let queued) = received[2] else { return XCTFail("expected queued") }
        XCTAssertEqual(queued.target, 4)

        await socket.close()
    }

    func testSendingEncodesAnIntentTheServerCouldParse() async throws {
        let transport = StubTransport()
        let socket = GameSocket(transport: transport)
        _ = try await socket.connect()

        try await socket.send(.hello(.init(protocolVersion: protocolVersion, token: nil)))
        try await socket.send(.bid(.init(matchId: "m1", bid: Bid(quantity: 2, face: .four))))

        let written = try await transport.writtenMessages()
        XCTAssertEqual(written.count, 2)
        guard case .bid(let bid) = written[1] else { return XCTFail("expected a bid") }
        XCTAssertEqual(bid.matchId, "m1")
        XCTAssertEqual(bid.bid, Bid(quantity: 2, face: .four))

        await socket.close()
    }

    func testTheStreamFinishesWhenTheSocketClosesRatherThanHanging() async throws {
        let transport = StubTransport()
        let socket = GameSocket(transport: transport)
        let stream = try await socket.connect()
        try await transport.push(welcome())

        // A dropped connection has to end the `for await`, or the session's pump would sit there
        // forever and never try to reconnect.
        var count = 0
        let task = Task {
            for await _ in stream { count += 1 }
            return count
        }
        try await Task.sleep(for: .milliseconds(30))
        await transport.finish()

        let delivered = await task.value
        XCTAssertEqual(delivered, 1)
        await socket.close()
    }

    func testAnUndecodableFrameIsSkippedRatherThanFatal() async throws {
        let transport = StubTransport()
        let socket = GameSocket(transport: transport)
        let stream = try await socket.connect()

        await transport.push("{\"type\":\"nonsenseFromTheFuture\"}")
        await transport.push("not json at all")
        try await transport.push(ServerMessage.pong)

        var received: [ServerMessage] = []
        for await message in stream {
            received.append(message)
            break
        }

        // The two bad frames were recorded and stepped over; the good one still arrived. One
        // unreadable message must not tear down a match in progress.
        XCTAssertEqual(received, [.pong])
        let skipped = await socket.undecodableFrames
        XCTAssertEqual(skipped.count, 2)
        await socket.close()
    }

    func testSendingAfterCloseFails() async throws {
        let transport = StubTransport()
        let socket = GameSocket(transport: transport)
        _ = try await socket.connect()
        await socket.close()

        do {
            try await socket.send(.ping)
            XCTFail("expected a failure")
        } catch {
            XCTAssertTrue(error is GameSocket.Failure)
        }
    }
}
