import Foundation

/// The seam between `GameSocket` and an actual network connection.
///
/// `GameSocket` owns the protocol conversation — hello, framing, decoding — and nothing about
/// sockets. Putting the byte pipe behind a protocol means the socket actor can be tested by
/// feeding it a scripted transcript instead of standing up a server, which is what
/// `Tests/GameSocketTests.swift` does.
///
/// Swift note: this is a *protocol*, the rough equivalent of a Java interface. `Sendable` is a
/// marker meaning "safe to hand between concurrency domains"; Swift 6 enforces it at compile
/// time, so without it the compiler would refuse to let a transport cross into an actor.
protocol MessageTransport: Sendable {
    /// Open the connection. Throws if it cannot be established.
    func connect() async throws

    /// Send one text frame.
    func send(_ text: String) async throws

    /// Wait for the next text frame. Throws `TransportError.closed` when the peer hangs up.
    func receive() async throws -> String

    /// Close from our side. Safe to call more than once.
    ///
    /// Swift note: `async` because an actor implementing this protocol can only offer async
    /// members to the outside world. A synchronous implementation still satisfies it, which is
    /// why `WebSocketTransport.close()` below is plain.
    func close() async
}

enum TransportError: Error, Equatable {
    case closed
    case notConnected
    /// A binary frame, which this protocol never uses.
    case unexpectedFrame
}

/// A `MessageTransport` over `URLSessionWebSocketTask`.
///
/// PLAN.md picked `URLSessionWebSocketTask` deliberately: it is part of Foundation, so the app
/// ships with no third-party networking dependency at all.
///
/// Swift note: `final class` plus `@unchecked Sendable` is a deliberate escape hatch. The task
/// it wraps is thread-safe, but the compiler cannot prove that, so this asserts it instead —
/// and the assertion is small and local, which is the only kind worth making.
final class WebSocketTransport: MessageTransport, @unchecked Sendable {
    private let url: URL
    private let session: URLSession
    private let task: URLSessionWebSocketTask

    init(url: URL, session: URLSession = .shared) {
        self.url = url
        self.session = session
        self.task = session.webSocketTask(with: url)
    }

    func connect() async throws {
        task.resume()
    }

    func send(_ text: String) async throws {
        try await task.send(.string(text))
    }

    func receive() async throws -> String {
        // `URLSessionWebSocketTask.receive()` throws when the socket closes, which is exactly
        // how the read loop in GameSocket learns to stop.
        let frame = try await task.receive()
        switch frame {
        case .string(let text):
            return text
        case .data(let data):
            // The protocol is JSON text. A binary frame means something is wrong upstream.
            guard let text = String(data: data, encoding: .utf8) else {
                throw TransportError.unexpectedFrame
            }
            return text
        @unknown default:
            throw TransportError.unexpectedFrame
        }
    }

    func close() {
        task.cancel(with: .goingAway, reason: nil)
    }
}
