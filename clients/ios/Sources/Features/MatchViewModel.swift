import Foundation

/// The table screen's model. One view model per screen, per CLAUDE.md.
///
/// Everything here is either *the server's latest snapshot* or a presentation detail derived
/// from it. There is no rule in this file: it does not know that ones are wild, what beats what,
/// or who won a challenge. When it needs to know whether a bid is legal it reads
/// `snapshot.bidOptions` — six minimum quantities the server computed with the engine — which is
/// how the bid picker can grey out impossible combinations while containing zero rules logic.
@MainActor
@Observable
final class MatchViewModel {
    let matchId: String
    let myPlayerId: String

    private(set) var snapshot: MatchSnapshot?
    private(set) var lastSeq = 0
    /// Everything that has happened, newest last. The view shows the tail of it.
    private(set) var log: [ProtocolEvent] = []
    /// The server's most recent refusal of something this player tried.
    private(set) var rejection: ErrorCode?

    /// The bid being composed. Two plain mutable properties, bound straight to the controls.
    var draftQuantity = 1
    var draftFace: Face = .two

    private let send: (ClientMessage) -> Void
    private static let logLimit = 200

    init(matchId: String, myPlayerId: String, send: @escaping (ClientMessage) -> Void) {
        self.matchId = matchId
        self.myPlayerId = myPlayerId
        self.send = send
    }

    // MARK: - Inbound

    func apply(_ state: ServerMessage.State) {
        // Out-of-order or duplicate delivery would otherwise walk the view backwards. The
        // snapshot with the highest seq is the truth.
        guard state.seq >= lastSeq else { return }
        lastSeq = state.seq
        snapshot = state.snapshot
        log.append(contentsOf: state.events)
        if log.count > Self.logLimit { log.removeFirst(log.count - Self.logLimit) }
        rejection = nil
        clampDraft()
    }

    func reject(_ code: ErrorCode) {
        rejection = code
    }

    // MARK: - What the view renders

    var view: PlayerView? { snapshot?.view }

    /// Own dice. The only hand any client is ever sent before a reveal (R-03, R-20).
    var myDice: [Face] { view?.you?.dice ?? [] }

    var players: [PublicPlayer] { view?.players ?? [] }

    var isMyTurn: Bool {
        guard case .bidding(let bidding) = view?.phase else { return false }
        return bidding.turnId == myPlayerId
    }

    var turnHolder: String? {
        guard case .bidding(let bidding) = view?.phase else { return nil }
        return bidding.turnId
    }

    var standingBid: Bid? { view?.round.bids.last?.bid }

    var bidHistory: [BidRecord] { view?.round.bids ?? [] }

    var isPalifico: Bool { view?.round.palifico ?? false }

    var lockedFace: Face? { view?.round.lockedFace }

    var totalDiceInPlay: Int { view?.totalDiceInPlay ?? 0 }

    var roundNumber: Int { (view?.round.index ?? 0) + 1 }

    /// Non-nil exactly while the server is holding the table on a reveal (R-10).
    var revealOnShow: RevealSummary? {
        guard view?.phase == .reveal else { return nil }
        return view?.lastReveal
    }

    var winnerId: String? {
        guard case .ended(let ended) = view?.phase else { return nil }
        return ended.winnerId
    }

    var iWon: Bool { winnerId == myPlayerId }

    var turnEndsInMs: Int? { snapshot?.turnEndsInMs }

    /// Who is actually playing each seat, so the view can mark a bot-held one (R-17, R-18).
    func seat(of playerId: String) -> SeatStatus? {
        snapshot?.seats.first { $0.playerId == playerId }
    }

    var iAmBotControlled: Bool { seat(of: myPlayerId)?.control == .bot }

    // MARK: - The bid picker

    /// The faces that can be bid at all right now, in face order.
    var biddableFaces: [Face] {
        guard let options = snapshot?.bidOptions else { return [] }
        return options.options.filter { $0.minQuantity != nil }.map(\.face)
    }

    /// The cheapest quantity the server will accept for a face, or nil if it cannot be bid.
    func minimumQuantity(for face: Face) -> Int? {
        snapshot?.bidOptions?.options.first { $0.face == face }?.minQuantity
    }

    /// R-04's ceiling: no bid may name more dice than are on the table.
    var maximumQuantity: Int { snapshot?.bidOptions?.maxQuantity ?? 0 }

    /// Whether the composed bid would be accepted — asked of the server's answers, not worked
    /// out here.
    var draftIsLegal: Bool {
        guard let minimum = minimumQuantity(for: draftFace) else { return false }
        return draftQuantity >= minimum && draftQuantity <= maximumQuantity
    }

    /// R-06: the player who opens a round must bid, so challenging is not offered to them.
    var canChallenge: Bool { isMyTurn && standingBid != nil }

    var canBid: Bool { isMyTurn && draftIsLegal }

    /// Pull the draft back into legal range whenever a new snapshot arrives, so the controls
    /// never sit on something the server would refuse.
    private func clampDraft() {
        guard snapshot?.bidOptions != nil else { return }
        if minimumQuantity(for: draftFace) == nil, let fallback = biddableFaces.first {
            draftFace = fallback
        }
        if let minimum = minimumQuantity(for: draftFace) {
            draftQuantity = max(minimum, min(draftQuantity, maximumQuantity))
        }
    }

    func choose(face: Face) {
        draftFace = face
        clampDraft()
    }

    func nudgeQuantity(by delta: Int) {
        let minimum = minimumQuantity(for: draftFace) ?? 1
        draftQuantity = max(minimum, min(draftQuantity + delta, maximumQuantity))
    }

    // MARK: - Intents

    func submitBid() {
        guard canBid else { return }
        rejection = nil
        send(.bid(.init(matchId: matchId, bid: Bid(quantity: draftQuantity, face: draftFace))))
    }

    func callDudo() {
        guard canChallenge else { return }
        rejection = nil
        send(.dudo(.init(matchId: matchId)))
    }
}
