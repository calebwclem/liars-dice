import Foundation

/// The single point of contact with the server.
///
/// CLAUDE.md asks for exactly this: one `actor GameSocket` wrapping the WebSocket, exposing an
/// `AsyncStream<ServerMessage>`, with all socket access going through it. Everything above this
/// type deals in decoded `ServerMessage` values and never touches a frame.
///
/// Swift note: an `actor` is a reference type whose mutable state is protected by the compiler.
/// Calls in from outside are `await`ed and serialised, so `continuation` and `readTask` below
/// cannot be touched by two tasks at once — the same guarantee a `synchronized` block gives in
/// Java, except the compiler checks that you did not forget it.
actor GameSocket {
    /// What went wrong, in terms the session layer can act on.
    enum Failure: Error {
        /// The socket closed. Expected on a dropped connection; the session reconnects.
        case disconnected
        /// A frame arrived that does not match the protocol — a server/client version skew.
        case undecodable(String)
    }

    private let transport: any MessageTransport
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    /// Feeds the stream handed out by `messages()`. Nil until that is called.
    private var continuation: AsyncStream<ServerMessage>.Continuation?
    private var readTask: Task<Void, Never>?
    private var closed = false

    /// Frames that could not be decoded. Surfaced for diagnostics rather than thrown away
    /// silently, since a non-zero count means the client and server disagree about the wire.
    private(set) var undecodableFrames: [String] = []

    init(transport: any MessageTransport) {
        self.transport = transport
    }

    /// Connect and start reading. Returns a stream of decoded messages that finishes when the
    /// socket closes, so `for await` over it ends on disconnect rather than hanging.
    ///
    /// Swift note: `AsyncStream` is a bridge from a callback-style source to `for await`. The
    /// read loop below pushes values in; the caller pulls them out. When the loop finishes it
    /// calls `finish()`, which is what ends the caller's loop.
    func connect() async throws -> AsyncStream<ServerMessage> {
        guard !closed else { throw Failure.disconnected }
        try await transport.connect()

        let stream = AsyncStream<ServerMessage> { continuation in
            self.continuation = continuation
        }
        readTask = Task { await self.readLoop() }
        return stream
    }

    /// Send one intent. Encoding is total — `ClientMessage` is generated from the schema the
    /// server validates against — so a throw here is always a transport problem.
    func send(_ message: ClientMessage) async throws {
        guard !closed else { throw Failure.disconnected }
        let data = try encoder.encode(message)
        guard let text = String(data: data, encoding: .utf8) else {
            throw Failure.undecodable("could not encode \(message.type)")
        }
        try await transport.send(text)
    }

    func close() async {
        guard !closed else { return }
        closed = true
        readTask?.cancel()
        readTask = nil
        await transport.close()
        continuation?.finish()
        continuation = nil
    }

    // MARK: - Reading

    private func readLoop() async {
        while !closed {
            let text: String
            do {
                text = try await transport.receive()
            } catch {
                // Either the peer hung up or we cancelled. Both mean the stream is over.
                break
            }
            if Task.isCancelled { break }
            deliver(text)
        }
        continuation?.finish()
        continuation = nil
    }

    private func deliver(_ text: String) {
        guard let data = text.data(using: .utf8) else {
            undecodableFrames.append(text)
            return
        }
        do {
            let message = try decoder.decode(ServerMessage.self, from: data)
            continuation?.yield(message)
        } catch {
            // A frame we cannot read is recorded and skipped rather than treated as fatal: one
            // unknown message must not tear down a match in progress.
            undecodableFrames.append(text)
        }
    }
}
