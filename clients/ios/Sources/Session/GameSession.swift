import Foundation

/// Where the app is, and the one thing that pumps the socket.
///
/// The division of labour matters here. `GameSocket` speaks bytes; this speaks *messages*. It
/// owns the app's stage (connecting, in the lobby, queued, playing), routes each inbound message
/// to whoever cares, and handles reconnection. It holds no rules: every decision about the game
/// is the server's, and this object's job is to relay intents one way and snapshots the other.
///
/// Swift note: `@Observable` is the modern replacement for `ObservableObject`. Mutating any
/// stored property here tells SwiftUI to re-render whichever views read that particular
/// property — no `@Published`, no `objectWillChange`. `@MainActor` pins the whole class to the
/// main thread, which is what makes it safe for views to read while the socket actor runs
/// elsewhere.
@MainActor
@Observable
final class GameSession {
    /// The screen the app should be showing.
    enum Stage: Equatable {
        case idle
        case connecting
        case lobby
        case queued(waiting: Int, target: Int, backfillInMs: Int)
        /// A private game, gathered behind a code and waiting for its host to start.
        case party(ServerMessage.PartyState)
        case playing
        /// The server speaks a protocol this build does not (PLAN.md's version gate).
        case needsUpdate(serverVersion: Int)
        case failed(String)
    }

    private(set) var stage: Stage = .idle
    private(set) var playerId: String?
    private(set) var match: MatchViewModel?
    /// The most recent rejection, for the view to show. Cleared when the player acts again.
    private(set) var lastError: ErrorCode?
    private(set) var reconnecting = false

    private let endpoint: URL
    private let tokens: any TokenStore
    private let makeTransport: @Sendable (URL) -> any MessageTransport

    private var socket: GameSocket?
    private var pump: Task<Void, Never>?
    /// Set while a match is live, so a reconnect knows what to resume.
    private var resumable: (matchId: String, afterSeq: Int)?

    init(
        endpoint: URL,
        tokens: any TokenStore,
        makeTransport: @escaping @Sendable (URL) -> any MessageTransport = { url in
            WebSocketTransport(url: url)
        }
    ) {
        self.endpoint = endpoint
        self.tokens = tokens
        self.makeTransport = makeTransport
    }

    // MARK: - Connecting

    func connect() async {
        guard stage == .idle || isFailed(stage) else { return }
        stage = .connecting
        await openSocket()
    }

    private func openSocket() async {
        let socket = GameSocket(transport: makeTransport(endpoint))
        self.socket = socket
        do {
            let stream = try await socket.connect()
            // Swift note: this Task outlives the function. It reads the stream until the socket
            // closes, then falls through to `handleStreamEnded` — so a dropped connection is a
            // normal completion rather than an error to catch.
            pump = Task { [weak self] in
                // Swift note: this Task inherits the enclosing @MainActor context, so `handle`
                // needs no `await` — it is already running where it belongs.
                for await message in stream {
                    self?.handle(message)
                }
                await self?.handleStreamEnded()
            }
            try await socket.send(.hello(.init(protocolVersion: protocolVersion, token: tokens.read())))
        } catch {
            stage = .failed(String(describing: error))
        }
    }

    func disconnect() {
        pump?.cancel()
        pump = nil
        let closing = socket
        socket = nil
        resumable = nil
        match = nil
        stage = .idle
        Task { await closing?.close() }
    }

    // MARK: - Intents

    func findMatch() {
        lastError = nil
        send(.findMatch)
    }

    func cancelQueue() {
        send(.cancelQueue)
    }

    // MARK: - Private games

    func createParty() {
        lastError = nil
        send(.createParty)
    }

    /// Joins by code. The wire contract is strict and uppercase, so normalising is the client's
    /// job — a player typing "ab 3f" into a text field should not be told their code is malformed.
    func joinParty(code: String) {
        lastError = nil
        send(.joinParty(.init(code: GameSession.normalise(code))))
    }

    func leaveParty() {
        send(.leaveParty)
    }

    func startParty(fillWithBots: Bool) {
        lastError = nil
        send(.startParty(.init(fillWithBots: fillWithBots)))
    }

    /// Uppercased, with anything outside the code alphabet dropped.
    static func normalise(_ code: String) -> String {
        String(code.uppercased().filter { partyCodeAlphabet.contains($0) }.prefix(partyCodeLength))
    }

    /// Whether a typed code is worth sending at all. The server would refuse a short one as a
    /// bad message, which is a worse thing to show a player than a disabled button.
    static func isCompleteCode(_ code: String) -> Bool {
        normalise(code).count == partyCodeLength
    }

    func leaveMatch() {
        guard let matchId = match?.matchId else { return }
        send(.leave(.init(matchId: matchId)))
        match = nil
        resumable = nil
        stage = .lobby
    }

    private func send(_ message: ClientMessage) {
        guard let socket else { return }
        Task {
            do {
                try await socket.send(message)
            } catch {
                await MainActor.run { self.stage = .failed(String(describing: error)) }
            }
        }
    }

    // MARK: - Inbound

    private func handle(_ message: ServerMessage) {
        switch message {
        case .welcome(let welcome):
            playerId = welcome.playerId
            tokens.write(welcome.token)
            reconnecting = false
            // A reconnect lands here too. R-18: the client asks for a resync rather than the
            // server guessing what it missed.
            if let resumable {
                send(.resume(.init(matchId: resumable.matchId, afterSeq: resumable.afterSeq)))
                stage = .playing
            } else {
                stage = .lobby
            }

        case .updateRequired(let update):
            stage = .needsUpdate(serverVersion: update.serverProtocolVersion)

        case .queued(let queued):
            stage = .queued(
                waiting: queued.waiting,
                target: queued.target,
                backfillInMs: queued.backfillInMs
            )

        case .queueCancelled:
            stage = .lobby

        case .partyState(let party):
            stage = .party(party)

        case .partyLeft:
            stage = .lobby

        case .matchFound(let found):
            // On a reconnect the server re-announces the match; keep the existing view model so
            // the event log the player has already seen is not thrown away.
            if match?.matchId != found.matchId {
                match = MatchViewModel(
                    matchId: found.matchId,
                    myPlayerId: playerId ?? "",
                    send: { [weak self] message in self?.send(message) }
                )
            }
            resumable = (found.matchId, match?.lastSeq ?? 0)
            stage = .playing

        case .state(let state):
            match?.apply(state)
            resumable = (state.matchId, state.seq)
            if stage != .playing { stage = .playing }

        case .error(let failure):
            lastError = failure.code
            match?.reject(failure.code)

        case .pong:
            break
        }
    }

    /// The socket closed. If a match was in progress, get back in (R-18).
    private func handleStreamEnded() async {
        socket = nil
        pump = nil
        guard resumable != nil else {
            if stage != .idle, !isNeedsUpdate(stage) { stage = .idle }
            return
        }
        reconnecting = true
        // One immediate attempt, then a short backoff. The server holds the seat for 45 seconds
        // (R-18), so there is time, but not a lot of it.
        for delay in [0.0, 0.5, 1.0, 2.0, 4.0] {
            if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
            if Task.isCancelled { return }
            await openSocket()
            if socket != nil { return }
        }
        reconnecting = false
        stage = .failed("could not reconnect")
    }

    private func isFailed(_ stage: Stage) -> Bool {
        if case .failed = stage { return true }
        return false
    }

    private func isNeedsUpdate(_ stage: Stage) -> Bool {
        if case .needsUpdate = stage { return true }
        return false
    }
}
