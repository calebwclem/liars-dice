import XCTest
@testable import LiarsDice

/// The generated models against real server output.
///
/// `Tests/Fixtures/transcript.json` was captured by `pnpm fixtures` from an actual `Room` playing
/// an actual match — every message one player received, byte for byte. A hand-written fixture
/// would only prove the models agree with whoever wrote it; this proves they agree with the
/// server. If the protocol changes and the fixture is not regenerated, this fails, which is the
/// point.
final class ProtocolDecodingTests: XCTestCase {
    private struct Transcript: Decodable {
        let seed: Int
        let playerId: String
        let winnerId: String?
        let messages: [ServerMessage]
    }

    private func loadTranscript() throws -> Transcript {
        let bundle = Bundle(for: Self.self)
        let url = try XCTUnwrap(
            bundle.url(forResource: "transcript", withExtension: "json"),
            "transcript.json is missing from the test bundle — run `pnpm fixtures`"
        )
        return try JSONDecoder().decode(Transcript.self, from: Data(contentsOf: url))
    }

    func testEveryMessageOfARealMatchDecodes() throws {
        let transcript = try loadTranscript()
        XCTAssertGreaterThan(transcript.messages.count, 50)

        // A whole match: the first message seats the player, the last one has a winner.
        let states = transcript.messages.compactMap { message -> ServerMessage.State? in
            if case .state(let state) = message { return state }
            return nil
        }
        XCTAssertGreaterThan(states.count, 50)
        XCTAssertEqual(states.map(\.seq), states.map(\.seq).sorted(), "seq must be monotonic")

        let final = try XCTUnwrap(states.last)
        guard case .ended(let ended) = final.snapshot.view.phase else {
            return XCTFail("the fixture should end with a winner")
        }
        XCTAssertEqual(ended.winnerId, transcript.winnerId)
    }

    func testEveryEventVariantInTheFixtureIsUnderstood() throws {
        let transcript = try loadTranscript()
        let events = transcript.messages.flatMap { message -> [ProtocolEvent] in
            if case .state(let state) = message { return state.events }
            return []
        }
        // Decoding already proved each one maps to a case; this checks the fixture is broad
        // enough to be worth trusting, including the R-18 connection events.
        let types = Set(events.map(\.type))
        for expected in [
            "matchStarted", "roundStarted", "bidMade", "dudoCalled", "diceRevealed", "dieLost",
            "playerEliminated", "matchEnded", "playerDisconnected", "playerReconnected",
        ] {
            XCTAssertTrue(types.contains(expected), "fixture has no \(expected) event")
        }
        // Every event renders to something showable, so the feed cannot crash on a variant.
        for event in events {
            XCTAssertFalse(event.summary().isEmpty)
        }
    }

    /// R-03 / R-20. The server-side test asserts this too; asserting it again *here* means the
    /// claim is checked against what actually crossed the wire and was decoded by this client.
    func testNoMessageCarriesAnotherPlayersDice() throws {
        let transcript = try loadTranscript()
        let bundle = Bundle(for: Self.self)
        let url = try XCTUnwrap(bundle.url(forResource: "transcript", withExtension: "json"))
        let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: url))

        var offenders: [String] = []
        findDiceArrays(in: raw, path: "", into: &offenders)
        let leaked = offenders.filter { path in
            // Your own hand, and the hands a reveal makes public (R-10). Nothing else.
            !path.hasSuffix(".snapshot.view.you.dice")
                && !path.contains(".snapshot.view.lastReveal.hands.")
                && !path.contains(".reveal.hands.")
        }
        XCTAssertEqual(leaked, [], "a hand appeared somewhere it should not")

        // And the hand that *is* there belongs to the subject of the transcript.
        for message in transcript.messages {
            guard case .state(let state) = message, let you = state.snapshot.view.you else { continue }
            XCTAssertEqual(you.id, transcript.playerId)
        }
    }

    /// Walk the raw JSON for arrays that look like dice, so the check does not depend on the
    /// model shapes it is meant to be auditing.
    private func findDiceArrays(in value: Any, path: String, into out: inout [String]) {
        if let array = value as? [Any] {
            let faces = array.allSatisfy { element in
                if let number = element as? Int { return (1...6).contains(number) }
                return false
            }
            if !array.isEmpty, faces {
                out.append(path)
                return
            }
            for (index, element) in array.enumerated() {
                findDiceArrays(in: element, path: "\(path)[\(index)]", into: &out)
            }
            return
        }
        if let object = value as? [String: Any] {
            for (key, element) in object {
                findDiceArrays(in: element, path: "\(path).\(key)", into: &out)
            }
        }
    }

    // MARK: - Encoding

    func testClientMessagesEncodeTheWayTheServerExpects() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys

        let hello = try encoder.encode(ClientMessage.hello(.init(protocolVersion: 1, token: nil)))
        // An optional that is nil is left out entirely, which is what `.optional()` means in the
        // schema. Sending `"token": null` would be rejected.
        XCTAssertEqual(String(decoding: hello, as: UTF8.self), #"{"protocolVersion":1,"type":"hello"}"#)

        let withToken = try encoder.encode(
            ClientMessage.hello(.init(protocolVersion: 1, token: "abc"))
        )
        XCTAssertEqual(
            String(decoding: withToken, as: UTF8.self),
            #"{"protocolVersion":1,"token":"abc","type":"hello"}"#
        )

        let bid = try encoder.encode(
            ClientMessage.bid(.init(matchId: "m1", bid: Bid(quantity: 3, face: .five)))
        )
        XCTAssertEqual(
            String(decoding: bid, as: UTF8.self),
            #"{"bid":{"face":5,"quantity":3},"matchId":"m1","type":"bid"}"#
        )

        let dudo = try encoder.encode(ClientMessage.dudo(.init(matchId: "m1")))
        XCTAssertEqual(String(decoding: dudo, as: UTF8.self), #"{"matchId":"m1","type":"dudo"}"#)

        let ping = try encoder.encode(ClientMessage.ping)
        XCTAssertEqual(String(decoding: ping, as: UTF8.self), #"{"type":"ping"}"#)
    }

    func testEveryMessageSurvivesARoundTrip() throws {
        let transcript = try loadTranscript()
        let encoder = JSONEncoder()
        let decoder = JSONDecoder()
        for message in transcript.messages {
            let again = try decoder.decode(ServerMessage.self, from: try encoder.encode(message))
            XCTAssertEqual(again, message)
        }
    }

    func testAnUnknownMessageTypeIsRejectedRatherThanMisread() throws {
        let json = #"{"type":"somethingFromTheFuture","payload":1}"#
        XCTAssertThrowsError(
            try JSONDecoder().decode(ServerMessage.self, from: Data(json.utf8))
        )
    }

    func testFaceRejectsAValueOutsideOneToSix() throws {
        // R-02: six-sided dice. A seven is a protocol violation, not something to tolerate.
        XCTAssertThrowsError(try JSONDecoder().decode(Face.self, from: Data("7".utf8)))
        XCTAssertEqual(try JSONDecoder().decode(Face.self, from: Data("6".utf8)), .six)
    }
}
