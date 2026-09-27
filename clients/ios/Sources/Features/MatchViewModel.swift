import Foundation

/// The table screen's model. One view model per screen, per CLAUDE.md.
///
/// Everything here is either *the server's latest snapshot* or a presentation detail derived from
/// it. There is no rule in this file: it does not know that ones are wild, what beats what, or who
/// won a challenge. When it needs to know whether a bid is legal it reads `snapshot.bidOptions` —
/// six minimum quantities the server computed with the engine — which is how the bid picker can
/// grey out impossible combinations while containing zero rules logic.
///
/// Phase 4 added the *pacing*: a reveal is not a state, it is a short sequence, and this owns it.
@MainActor
@Observable
final class MatchViewModel {
    /// How long each beat of a reveal lasts. Injectable so tests do not have to wait for it.
    struct RevealPacing: Sendable {
        var cupLift: Duration = .milliseconds(560)
        var hands: Duration = .milliseconds(420)
        var counting: Duration = .milliseconds(900)
        var verdict: Duration = .milliseconds(620)

        static let standard = RevealPacing()
        /// Everything at once, for tests.
        static let instant = RevealPacing(
            cupLift: .zero, hands: .zero, counting: .zero, verdict: .zero
        )
    }

    /// Where a reveal has got to. R-10 happens in one atomic step on the server; a person needs
    /// it spread over a couple of seconds to follow what happened to them.
    enum RevealBeat: Int, Comparable, Sendable {
        /// The cup is coming up. Nobody's dice are visible yet.
        case cupLift
        /// Every hand is on the table (R-10: the one moment they are public).
        case hands
        /// The dice that count toward the bid light up.
        case counting
        /// Good bid, or a lie.
        case verdict
        /// The die comes off the table, and somebody may be out.
        case outcome

        static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }
    }

    let matchId: String
    let myPlayerId: String

    private(set) var snapshot: MatchSnapshot?
    private(set) var lastSeq = 0
    /// Everything that has happened, newest last. The view shows the tail of it.
    private(set) var log: [ProtocolEvent] = []
    /// The server's most recent refusal of something this player tried.
    private(set) var rejection: ErrorCode?
    /// Advances through a reveal while the server holds the table.
    private(set) var revealBeat: RevealBeat = .cupLift
    /// Bumped whenever a new round is dealt, so the hand re-rolls.
    private(set) var rollToken = 0

    /// The bid being composed. Two plain mutable properties, bound straight to the controls.
    var draftQuantity = 1
    var draftFace: Face = .two

    private let send: (ClientMessage) -> Void
    private let pacing: RevealPacing
    private let now: () -> Date
    private let feedback: (Haptics.Beat) -> Void
    private var revealTask: Task<Void, Never>?
    private var lastRoundIndex = -1
    private var lastTurnHolder: String?
    private var lastRevealRound = -1
    private static let logLimit = 200

    init(
        matchId: String,
        myPlayerId: String,
        send: @escaping (ClientMessage) -> Void,
        pacing: RevealPacing = .standard,
        now: @escaping () -> Date = Date.init,
        feedback: @escaping (Haptics.Beat) -> Void = { beat in Haptics.shared.play(beat) }
    ) {
        self.matchId = matchId
        self.myPlayerId = myPlayerId
        self.send = send
        self.pacing = pacing
        self.now = now
        self.feedback = feedback
    }

    // MARK: - Inbound

    func apply(_ state: ServerMessage.State) {
        // Out-of-order or duplicate delivery would otherwise walk the view backwards. The
        // snapshot with the highest seq is the truth.
        guard state.seq >= lastSeq else { return }
        let firstSnapshot = snapshot == nil
        lastSeq = state.seq
        snapshot = state.snapshot
        log.append(contentsOf: state.events)
        if log.count > Self.logLimit { log.removeFirst(log.count - Self.logLimit) }
        rejection = nil
        clampDraft()

        // A resync is the player catching up on things they already missed. Replaying the whole
        // feel of it — buzzing once per die, once per bid — would be nonsense, so a sync updates
        // state silently and only live play is felt.
        let live = state.kind == .update && !firstSnapshot
        reactToRound(live: live)
        reactToEvents(state.events, live: live)
        reactToPhase(live: live)
    }

    func reject(_ code: ErrorCode) {
        rejection = code
        feedback(.rejected)
    }

    /// A new round means a fresh roll (R-03), which is the most physical moment in the game.
    private func reactToRound(live: Bool) {
        guard let round = view?.round, round.index != lastRoundIndex else { return }
        lastRoundIndex = round.index
        rollToken += 1
        if live, !myDice.isEmpty { Haptics.shared.rollHand(count: myDice.count) }
    }

    private func reactToEvents(_ events: [ProtocolEvent], live: Bool) {
        guard live else { return }
        for event in events {
            switch event {
            case .bidMade(let bid) where bid.playerId != myPlayerId:
                feedback(.bidPlaced)
            case .dudoCalled:
                feedback(.challenge)
            case .matchEnded(let ended):
                feedback(.matchOver(won: ended.winnerId == myPlayerId))
            default:
                break
            }
        }
    }

    private func reactToPhase(live: Bool) {
        switch view?.phase {
        case .bidding(let bidding):
            if bidding.turnId != lastTurnHolder {
                lastTurnHolder = bidding.turnId
                if live, bidding.turnId == myPlayerId { feedback(.yourTurn) }
            }
            endReveal()
        case .reveal:
            lastTurnHolder = nil
            startReveal(live: live)
        case .ended, .none:
            lastTurnHolder = nil
            endReveal()
        }
    }

    // MARK: - The reveal sequence

    private func startReveal(live: Bool) {
        guard let reveal = view?.lastReveal, reveal.roundIndex != lastRevealRound else { return }
        lastRevealRound = reveal.roundIndex
        revealTask?.cancel()
        revealBeat = .cupLift

        // Weak, so a player who leaves mid-reveal is not kept alive by the animation. The task
        // also stops at the first cancelled step, which is what `endReveal` relies on.
        revealTask = Task { [weak self, pacing, feedback] in
            if live { feedback(.cupLift) }
            guard await self?.step(to: .hands, after: pacing.cupLift) == true else { return }
            guard await self?.step(to: .counting, after: pacing.hands) == true else { return }
            guard await self?.step(to: .verdict, after: pacing.counting) == true else { return }
            if live { feedback(.verdict(good: reveal.bidStands)) }
            guard await self?.step(to: .outcome, after: pacing.verdict) == true else { return }
            if live {
                feedback(.dieLost)
                if reveal.eliminatedId != nil { feedback(.elimination) }
            }
        }
    }

    /// Wait, then advance — returning false if the sequence was cancelled while sleeping.
    private func step(to beat: RevealBeat, after pause: Duration) async -> Bool {
        try? await Task.sleep(for: pause)
        guard !Task.isCancelled else { return false }
        revealBeat = beat
        return true
    }

    private func endReveal() {
        revealTask?.cancel()
        revealTask = nil
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

    /// R-16, as a moment on this device's clock. Nil when nobody is on the clock.
    var turnDeadline: Date? {
        guard let remaining = snapshot?.turnEndsInMs, view?.phase != .reveal else { return nil }
        return now().addingTimeInterval(Double(remaining) / 1000)
    }

    var turnLength: TimeInterval { Double(snapshot?.turnMs ?? 30_000) / 1000 }

    /// Who is actually playing each seat, so the view can mark a bot-held one (R-17, R-18).
    func seat(of playerId: String) -> SeatStatus? {
        snapshot?.seats.first { $0.playerId == playerId }
    }

    var iAmBotControlled: Bool { seat(of: myPlayerId)?.control == .bot }

    /// How the feed should refer to people, from this player's point of view.
    var naming: EventNaming {
        EventNaming(name: shortName, isMe: { [myPlayerId] id in id == myPlayerId })
    }

    /// A short name for a guest id, which is otherwise a UUID that wraps across the screen.
    func shortName(_ playerId: String) -> String {
        if playerId == myPlayerId { return "You" }
        if playerId.hasPrefix("bot_") { return "Bot \(playerId.suffix(4))" }
        let trimmed = playerId.hasPrefix("g_") ? String(playerId.dropFirst(2)) : playerId
        return "Player \(trimmed.prefix(4))"
    }

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

    /// Whether the composed bid would be accepted — asked of the server's answers, not worked out
    /// here.
    var draftIsLegal: Bool {
        guard let minimum = minimumQuantity(for: draftFace) else { return false }
        return draftQuantity >= minimum && draftQuantity <= maximumQuantity
    }

    /// R-06: the player who opens a round must bid, so challenging is not offered to them.
    var canChallenge: Bool { isMyTurn && standingBid != nil }

    var canBid: Bool { isMyTurn && draftIsLegal }

    /// Why the bid controls are unavailable, in a sentence, or nil when they are fine.
    ///
    /// Every branch is read off the server's answers rather than worked out here — which is also
    /// why the wording explains the *situation* and never the rule that caused it.
    var bidBlockedReason: String? {
        guard isMyTurn else { return nil }
        if iAmBotControlled { return "A bot is playing your seat." }
        guard snapshot?.bidOptions != nil else { return nil }
        if biddableFaces.isEmpty {
            return "There is no higher bid left to make — challenging is your only move."
        }
        return nil
    }

    /// Pull the draft back into legal range whenever a new snapshot arrives, so the controls never
    /// sit on something the server would refuse.
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
