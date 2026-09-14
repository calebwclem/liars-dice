import Foundation
@testable import LiarsDice

/// A `MessageTransport` that replays a script instead of opening a socket.
///
/// This is what makes the socket actor and the session testable without a server: the test hands
/// over a list of frames the "server" will send, and reads back whatever the client wrote. It is
/// also the stubbed server behind the scripted-match test, which CLAUDE.md asks for.
///
/// Swift note: an `actor` here for the same reason `GameSocket` is one — the test writes the
/// script from one task while the socket reads it from another, and the compiler will not allow
/// that over a plain class without proving it is safe.
actor StubTransport: MessageTransport {
    private var pending: [String]
    private var sent: [String] = []
    private var closed = false
    /// Resumed when a frame arrives after `receive()` has already started waiting.
    private var waiter: CheckedContinuation<String, any Error>?
    private(set) var connectCount = 0

    init(script: [String] = []) {
        self.pending = script
    }

    func connect() async throws {
        connectCount += 1
    }

    func send(_ text: String) async throws {
        guard !closed else { throw TransportError.closed }
        sent.append(text)
    }

    func receive() async throws -> String {
        if let next = pending.first {
            pending.removeFirst()
            return next
        }
        if closed { throw TransportError.closed }
        // Nothing queued: suspend until `push` or `finish` wakes us. This is how the stub
        // imitates a quiet socket rather than spinning.
        return try await withCheckedThrowingContinuation { continuation in
            waiter = continuation
        }
    }

    func close() {
        closed = true
        waiter?.resume(throwing: TransportError.closed)
        waiter = nil
    }

    // MARK: - Test controls

    /// Deliver a frame to the client.
    func push(_ text: String) {
        if let waiter {
            self.waiter = nil
            waiter.resume(returning: text)
        } else {
            pending.append(text)
        }
    }

    func push(_ message: some Encodable) throws {
        let data = try JSONEncoder().encode(message)
        push(String(decoding: data, as: UTF8.self))
    }

    /// Hang up, the way a dropped connection would.
    func finish() {
        closed = true
        waiter?.resume(throwing: TransportError.closed)
        waiter = nil
    }

    /// Everything the client has written, in order.
    func writtenFrames() -> [String] {
        sent
    }

    /// The client's messages, decoded. Fails the caller's expectations if anything is off-schema.
    func writtenMessages() throws -> [ClientMessage] {
        let decoder = JSONDecoder()
        return try sent.map { try decoder.decode(ClientMessage.self, from: Data($0.utf8)) }
    }
}
