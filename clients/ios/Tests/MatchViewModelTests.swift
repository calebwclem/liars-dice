import XCTest
@testable import LiarsDice

/// The table's view model. Every case here is about *presentation and intent* — whether a button
/// should be live, what the picker offers, which snapshot wins. The rules themselves are the
/// server's and are tested in `packages/engine`; if a test in this file starts needing to know
/// that ones are wild, something has leaked into the client.
@MainActor
final class MatchViewModelTests: XCTestCase {
    private var sent: [ClientMessage] = []
    private var felt: [String] = []
    private var clock = Date(timeIntervalSince1970: 1_000)

    /// Reveal pacing is instant and haptics are recorded rather than played, so the feel of the
    /// game is asserted on rather than waited for.
    private func makeModel(myPlayerId: String = "p1") -> MatchViewModel {
        sent = []
        felt = []
        return MatchViewModel(
            matchId: "m1",
            myPlayerId: myPlayerId,
            send: { [weak self] message in self?.sent.append(message) },
            pacing: .instant,
            now: { [weak self] in self?.clock ?? Date() },
            feedback: { [weak self] beat in self?.felt.append(String(describing: beat)) }
        )
    }

    // MARK: - Builders

    private func player(_ id: String, seat: Int, dice: Int = 5) -> PublicPlayer {
        PublicPlayer(id: id, seat: seat, diceCount: dice, eliminated: dice == 0, palificoUsed: false)
    }

    private func seat(_ id: String, seat: Int, control: SeatControl = .human) -> SeatStatus {
        SeatStatus(playerId: id, seat: seat, connected: true, control: control, controlReason: nil)
    }

    private func snapshot(
        phase: Phase = .bidding(.init(turnId: "p1")),
        myDice: [Face] = [.two, .three, .four, .five, .six],
        bids: [BidRecord] = [],
        palifico: Bool = false,
        lockedFace: Face? = nil,
        lastReveal: RevealSummary? = nil,
        bidOptions: BidOptions? = nil,
        turnEndsInMs: Int? = 30_000,
        seats: [SeatStatus]? = nil
    ) -> MatchSnapshot {
        MatchSnapshot(
            view: PlayerView(
                matchId: "m1",
                seq: 1,
                config: MatchConfig(startingDice: 5, maxDice: 5),
                you: PlayerView.You(id: "p1", seat: 0, dice: myDice),
                players: [player("p1", seat: 0), player("p2", seat: 1)],
                phase: phase,
                round: PlayerView.Round(
                    index: 0,
                    palifico: palifico,
                    starterId: "p1",
                    lockedFace: lockedFace,
                    bids: bids
                ),
                lastReveal: lastReveal,
                totalDiceInPlay: 10
            ),
            turnEndsInMs: turnEndsInMs,
            turnMs: 30_000,
            seats: seats ?? [seat("p1", seat: 0), seat("p2", seat: 1)],
            bidOptions: bidOptions
        )
    }

    /// Options as the server would compute them: a minimum quantity per face, or nil.
    private func options(_ minimums: [Face: Int?], maxQuantity: Int = 10) -> BidOptions {
        BidOptions(
            options: Face.allCases.map { BidOption(face: $0, minQuantity: minimums[$0] ?? nil) },
            maxQuantity: maxQuantity
        )
    }

    private func state(
        _ snapshot: MatchSnapshot,
        seq: Int = 1,
        events: [ProtocolEvent] = [],
        kind: StateKind = .update
    ) -> ServerMessage.State {
        ServerMessage.State(kind: kind, matchId: "m1", seq: seq, events: events, snapshot: snapshot)
    }

    private func reveal(
        bidStands: Bool = false,
        eliminatedId: String? = nil,
        roundIndex: Int = 0
    ) -> RevealSummary {
        RevealSummary(
            roundIndex: roundIndex,
            challengerId: "p2",
            bidderId: "p1",
            bid: Bid(quantity: 3, face: .four),
            wildOnes: true,
            actualCount: bidStands ? 3 : 2,
            bidStands: bidStands,
            hands: ["p1": [.four, .two], "p2": [.six, .one]],
            loserId: bidStands ? "p2" : "p1",
            loserDiceCount: 4,
            eliminatedId: eliminatedId
        )
    }

    // MARK: - Snapshots

    func testAppliesASnapshotAndExposesOwnDice() {
        let model = makeModel()
        model.apply(state(snapshot()))
        XCTAssertEqual(model.myDice, [.two, .three, .four, .five, .six])
        XCTAssertTrue(model.isMyTurn)
        XCTAssertEqual(model.roundNumber, 1)
        XCTAssertEqual(model.totalDiceInPlay, 10)
    }

    func testAStaleSnapshotIsIgnored() {
        // Messages can arrive late or twice; the highest seq is the truth. Without this the view
        // would walk backwards to an older round.
        let model = makeModel()
        model.apply(state(snapshot(bids: [BidRecord(playerId: "p1", bid: Bid(quantity: 3, face: .four))]), seq: 5))
        model.apply(state(snapshot(bids: []), seq: 2))
        XCTAssertEqual(model.lastSeq, 5)
        XCTAssertEqual(model.bidHistory.count, 1)
    }

    func testTheEventLogIsAppendedAndCapped() {
        let model = makeModel()
        let event = ProtocolEvent.bidMade(.init(playerId: "p2", bid: Bid(quantity: 1, face: .two)))
        for seq in 1...260 {
            model.apply(state(snapshot(), seq: seq, events: [event]))
        }
        XCTAssertEqual(model.log.count, 200)
    }

    // MARK: - The bid picker

    func testThePickerOffersOnlyFacesTheServerSaysAreBiddable() {
        let model = makeModel()
        model.apply(state(snapshot(bidOptions: options([.four: 4, .five: 3, .six: 3]))))
        XCTAssertEqual(model.biddableFaces, [.four, .five, .six])
        XCTAssertEqual(model.minimumQuantity(for: .five), 3)
        XCTAssertNil(model.minimumQuantity(for: .two))
        XCTAssertEqual(model.maximumQuantity, 10)
    }

    func testTheDraftIsPulledIntoLegalRangeWhenASnapshotArrives() {
        let model = makeModel()
        model.draftFace = .two // not biddable in the snapshot below
        model.draftQuantity = 1
        model.apply(state(snapshot(bidOptions: options([.five: 4, .six: 4]))))

        XCTAssertEqual(model.draftFace, .five, "an unbiddable face should fall back")
        XCTAssertEqual(model.draftQuantity, 4, "quantity should rise to the minimum")
        XCTAssertTrue(model.canBid)
    }

    func testQuantityCannotBeNudgedOutOfRange() {
        let model = makeModel()
        model.apply(state(snapshot(bidOptions: options([.five: 4], maxQuantity: 6))))
        model.choose(face: .five)

        model.nudgeQuantity(by: -5)
        XCTAssertEqual(model.draftQuantity, 4, "cannot go below the minimum")
        model.nudgeQuantity(by: 99)
        XCTAssertEqual(model.draftQuantity, 6, "cannot exceed the dice in play")
    }

    func testNothingIsBiddableWhenTheServerOffersNoMinimums() {
        // R-09's dead end: off a maximal ones bid there is no legal raise, so challenging is the
        // only move. The view model reports that without knowing why.
        let model = makeModel()
        model.apply(
            state(
                snapshot(
                    bids: [BidRecord(playerId: "p2", bid: Bid(quantity: 2, face: .one))],
                    bidOptions: options([:])
                )
            )
        )
        XCTAssertEqual(model.biddableFaces, [])
        XCTAssertFalse(model.canBid)
        XCTAssertTrue(model.canChallenge)
    }

    func testPalificoOffersTheLockedFaceOnly() {
        let model = makeModel()
        model.apply(
            state(
                snapshot(
                    bids: [BidRecord(playerId: "p1", bid: Bid(quantity: 2, face: .three))],
                    palifico: true,
                    lockedFace: .three,
                    bidOptions: options([.three: 3])
                )
            )
        )
        XCTAssertTrue(model.isPalifico)
        XCTAssertEqual(model.lockedFace, .three)
        XCTAssertEqual(model.biddableFaces, [.three])
    }

    // MARK: - Turn and challenge gating

    func testChallengingIsNotOfferedOnAnOpeningBid() {
        // R-06: the round's first player must bid. The button is not offered rather than offered
        // and refused.
        let model = makeModel()
        model.apply(state(snapshot(bids: [], bidOptions: options([.two: 1]))))
        XCTAssertFalse(model.canChallenge)

        model.apply(
            state(
                snapshot(
                    bids: [BidRecord(playerId: "p2", bid: Bid(quantity: 1, face: .two))],
                    bidOptions: options([.two: 2])
                ),
                seq: 2
            )
        )
        XCTAssertTrue(model.canChallenge)
    }

    func testNothingIsOfferedWhenItIsSomebodyElsesTurn() {
        let model = makeModel()
        model.apply(
            state(snapshot(phase: .bidding(.init(turnId: "p2")), bidOptions: nil))
        )
        XCTAssertFalse(model.isMyTurn)
        XCTAssertFalse(model.canBid)
        XCTAssertFalse(model.canChallenge)
        XCTAssertEqual(model.turnHolder, "p2")
    }

    func testABotHeldSeatIsReportedSoTheViewCanSaySo() {
        // R-17 / R-18: once a bot holds the seat, the player cannot act on it.
        let model = makeModel()
        model.apply(
            state(snapshot(seats: [seat("p1", seat: 0, control: .bot), seat("p2", seat: 1)]))
        )
        XCTAssertTrue(model.iAmBotControlled)
    }

    // MARK: - Intents

    func testBiddingSendsTheComposedBid() {
        let model = makeModel()
        model.apply(state(snapshot(bidOptions: options([.five: 3]))))
        model.choose(face: .five)
        model.nudgeQuantity(by: 2)
        model.submitBid()

        XCTAssertEqual(sent.count, 1)
        guard case .bid(let payload) = sent[0] else { return XCTFail("expected a bid") }
        XCTAssertEqual(payload.matchId, "m1")
        XCTAssertEqual(payload.bid, Bid(quantity: 5, face: .five))
    }

    func testAnIllegalDraftIsNotSentAtAll() {
        let model = makeModel()
        model.apply(state(snapshot(bidOptions: options([.five: 4]))))
        model.draftFace = .two // no minimum, so unbiddable
        model.submitBid()
        XCTAssertTrue(sent.isEmpty)
    }

    func testDudoSendsAChallenge() {
        let model = makeModel()
        model.apply(
            state(
                snapshot(
                    bids: [BidRecord(playerId: "p2", bid: Bid(quantity: 3, face: .four))],
                    bidOptions: options([.four: 4])
                )
            )
        )
        model.callDudo()
        guard case .dudo(let payload) = sent.first else { return XCTFail("expected a dudo") }
        XCTAssertEqual(payload.matchId, "m1")
    }

    func testARejectionIsShownAndThenClearedByTheNextSnapshot() {
        let model = makeModel()
        model.apply(state(snapshot(bidOptions: options([.five: 3]))))
        model.reject(.bidTooLow)
        XCTAssertEqual(model.rejection, .bidTooLow)
        model.apply(state(snapshot(bidOptions: options([.five: 4])), seq: 2))
        XCTAssertNil(model.rejection)
    }

    // MARK: - Reveal and winner

    func testTheRevealIsShownOnlyWhileTheServerHoldsTheTable() {
        let reveal = RevealSummary(
            roundIndex: 0,
            challengerId: "p2",
            bidderId: "p1",
            bid: Bid(quantity: 3, face: .four),
            wildOnes: true,
            actualCount: 2,
            bidStands: false,
            hands: ["p1": [.four, .two], "p2": [.six, .six]],
            loserId: "p1",
            loserDiceCount: 4,
            eliminatedId: nil
        )
        let model = makeModel()
        model.apply(state(snapshot(phase: .reveal, lastReveal: reveal)))
        XCTAssertEqual(model.revealOnShow?.actualCount, 2)
        // R-10: every hand is public at a reveal, and this is the only place they appear.
        XCTAssertEqual(model.revealOnShow?.hands.count, 2)

        // The next round starts and the reveal stops being the thing on screen, even though the
        // snapshot still carries it for a late-joining client.
        model.apply(state(snapshot(phase: .bidding(.init(turnId: "p1")), lastReveal: reveal), seq: 2))
        XCTAssertNil(model.revealOnShow)
    }

    func testTheWinnerIsReported() {
        let model = makeModel()
        model.apply(state(snapshot(phase: .ended(.init(winnerId: "p1")))))
        XCTAssertEqual(model.winnerId, "p1")
        XCTAssertTrue(model.iWon)
        XCTAssertFalse(model.canBid)

        let other = makeModel(myPlayerId: "p9")
        other.apply(state(snapshot(phase: .ended(.init(winnerId: "p1")))))
        XCTAssertFalse(other.iWon)
    }
}

// MARK: - Phase 4: how the table feels

@MainActor
final class MatchFeelTests: XCTestCase {
    private var sent: [ClientMessage] = []
    private var felt: [String] = []
    private var clock = Date(timeIntervalSince1970: 1_000)

    private func makeModel(myPlayerId: String = "p1") -> MatchViewModel {
        sent = []
        felt = []
        return MatchViewModel(
            matchId: "m1",
            myPlayerId: myPlayerId,
            send: { [weak self] message in self?.sent.append(message) },
            pacing: .instant,
            now: { [weak self] in self?.clock ?? Date() },
            feedback: { [weak self] beat in self?.felt.append(String(describing: beat)) }
        )
    }

    private func snapshot(
        phase: Phase = .bidding(.init(turnId: "p1")),
        roundIndex: Int = 0,
        lastReveal: RevealSummary? = nil,
        turnEndsInMs: Int? = 30_000
    ) -> MatchSnapshot {
        MatchSnapshot(
            view: PlayerView(
                matchId: "m1",
                seq: 1,
                config: MatchConfig(startingDice: 5, maxDice: 5),
                you: PlayerView.You(id: "p1", seat: 0, dice: [.five, .two]),
                players: [
                    PublicPlayer(id: "p1", seat: 0, diceCount: 2, eliminated: false, palificoUsed: false),
                    PublicPlayer(id: "p2", seat: 1, diceCount: 2, eliminated: false, palificoUsed: false),
                ],
                phase: phase,
                round: PlayerView.Round(
                    index: roundIndex,
                    palifico: false,
                    starterId: "p1",
                    lockedFace: nil,
                    bids: []
                ),
                lastReveal: lastReveal,
                totalDiceInPlay: 4
            ),
            turnEndsInMs: turnEndsInMs,
            turnMs: 30_000,
            seats: [
                SeatStatus(playerId: "p1", seat: 0, connected: true, control: .human, controlReason: nil),
                SeatStatus(playerId: "p2", seat: 1, connected: true, control: .human, controlReason: nil),
            ],
            bidOptions: nil
        )
    }

    private func state(
        _ snapshot: MatchSnapshot,
        seq: Int,
        events: [ProtocolEvent] = [],
        kind: StateKind = .update
    ) -> ServerMessage.State {
        ServerMessage.State(kind: kind, matchId: "m1", seq: seq, events: events, snapshot: snapshot)
    }

    private func sampleReveal(bidStands: Bool, eliminatedId: String? = nil, roundIndex: Int = 0)
        -> RevealSummary
    {
        RevealSummary(
            roundIndex: roundIndex,
            challengerId: "p2",
            bidderId: "p1",
            bid: Bid(quantity: 3, face: .four),
            wildOnes: true,
            actualCount: bidStands ? 3 : 2,
            bidStands: bidStands,
            hands: ["p1": [.four, .two], "p2": [.six, .one]],
            loserId: bidStands ? "p2" : "p1",
            loserDiceCount: 1,
            eliminatedId: eliminatedId
        )
    }

    /// Wait for the reveal task to run to completion. Pacing is `.instant`, so this is a yield
    /// rather than a sleep.
    private func settle() async {
        for _ in 0..<12 { await Task.yield() }
    }

    // MARK: - The reveal sequence

    func testARevealIsPacedRatherThanArrivingAllAtOnce() async {
        let model = makeModel()
        model.apply(state(snapshot(), seq: 1))
        XCTAssertEqual(model.revealBeat, .cupLift)

        model.apply(state(snapshot(phase: .reveal, lastReveal: sampleReveal(bidStands: false)), seq: 2))
        // It starts with the cup still down — nobody's dice are visible on the first frame.
        XCTAssertEqual(model.revealBeat, .cupLift)

        await settle()
        XCTAssertEqual(model.revealBeat, .outcome, "the sequence should run to the end")
    }

    func testTheRevealSequenceIsFeltInOrder() async {
        let model = makeModel()
        model.apply(state(snapshot(), seq: 1))
        model.apply(
            state(
                snapshot(phase: .reveal, lastReveal: sampleReveal(bidStands: true, eliminatedId: "p2")),
                seq: 2,
                events: [.dudoCalled(.init(playerId: "p2", bidderId: "p1", bid: Bid(quantity: 3, face: .four)))]
            )
        )
        await settle()

        // The challenge, then the cup, then the verdict, then the die, then the elimination —
        // in that order, because that is the order the player experiences them.
        XCTAssertEqual(
            felt,
            ["challenge", "cupLift", "verdict(good: true)", "dieLost", "elimination"]
        )
    }

    func testAResyncIsSilent() async {
        // R-18: catching up after a reconnect must not replay every buzz the player missed.
        let model = makeModel()
        model.apply(state(snapshot(), seq: 1, kind: .sync))
        model.apply(
            state(
                snapshot(phase: .reveal, lastReveal: sampleReveal(bidStands: false)),
                seq: 2,
                events: [.dudoCalled(.init(playerId: "p2", bidderId: "p1", bid: Bid(quantity: 3, face: .four)))],
                kind: .sync
            )
        )
        await settle()
        XCTAssertEqual(felt, [], "a sync should update state without any feedback")
        // ...but the state still caught up.
        XCTAssertEqual(model.revealBeat, .outcome)
    }

    func testTheFirstSnapshotOfAMatchIsSilent() {
        // Joining a table should not buzz for things that happened before you arrived.
        let model = makeModel()
        model.apply(state(snapshot(), seq: 1))
        XCTAssertEqual(felt, [])
    }

    func testANewRoundRerollsTheHand() {
        let model = makeModel()
        model.apply(state(snapshot(roundIndex: 0), seq: 1))
        let first = model.rollToken
        model.apply(state(snapshot(roundIndex: 1), seq: 2))
        XCTAssertGreaterThan(model.rollToken, first, "a new round should re-roll")

        model.apply(state(snapshot(roundIndex: 1), seq: 3))
        XCTAssertEqual(model.rollToken, first + 1, "the same round should not re-roll")
    }

    func testYourTurnIsFeltButSomebodyElsesIsNot() {
        let model = makeModel()
        model.apply(state(snapshot(phase: .bidding(.init(turnId: "p2"))), seq: 1))
        felt = []

        model.apply(state(snapshot(phase: .bidding(.init(turnId: "p1"))), seq: 2))
        XCTAssertEqual(felt, ["yourTurn"])

        felt = []
        model.apply(state(snapshot(phase: .bidding(.init(turnId: "p2"))), seq: 3))
        XCTAssertEqual(felt, [], "another player's turn is not your phone's business")
    }

    func testARefusalIsFelt() {
        let model = makeModel()
        model.apply(state(snapshot(), seq: 1))
        model.reject(.bidTooLow)
        XCTAssertEqual(felt, ["rejected"])
        XCTAssertEqual(model.rejection, .bidTooLow)
    }

    func testWinningAndLosingFeelDifferent() {
        let winner = makeModel(myPlayerId: "p1")
        winner.apply(state(snapshot(), seq: 1))
        winner.apply(
            state(
                snapshot(phase: .ended(.init(winnerId: "p1"))),
                seq: 2,
                events: [.matchEnded(.init(winnerId: "p1"))]
            )
        )
        XCTAssertTrue(felt.contains("matchOver(won: true)"))

        let loser = makeModel(myPlayerId: "p1")
        loser.apply(state(snapshot(), seq: 1))
        loser.apply(
            state(
                snapshot(phase: .ended(.init(winnerId: "p2"))),
                seq: 2,
                events: [.matchEnded(.init(winnerId: "p2"))]
            )
        )
        XCTAssertTrue(felt.contains("matchOver(won: false)"))
    }

    // MARK: - The turn ring

    func testTheTurnDeadlineIsRelativeToThisDevicesClock() {
        // Sent as "how long is left", not as a timestamp: a phone with a skewed clock would
        // otherwise draw the wrong ring.
        let model = makeModel()
        model.apply(state(snapshot(turnEndsInMs: 18_000), seq: 1))
        let deadline = try? XCTUnwrap(model.turnDeadline)
        XCTAssertEqual(deadline?.timeIntervalSince(clock) ?? 0, 18, accuracy: 0.01)
        XCTAssertEqual(model.turnLength, 30, accuracy: 0.01)
    }

    func testThereIsNoCountdownDuringAReveal() async {
        let model = makeModel()
        model.apply(state(snapshot(phase: .reveal, lastReveal: sampleReveal(bidStands: false)), seq: 1))
        XCTAssertNil(model.turnDeadline, "nobody is on the clock while the cups are up")
        await settle()
    }

    // MARK: - Names and hints

    func testGuestIdsAreShortenedIntoSomethingReadable() {
        let model = makeModel(myPlayerId: "g_1111")
        XCTAssertEqual(model.shortName("g_1111"), "You")
        XCTAssertEqual(model.shortName("g_abcd1234-5678"), "Player abcd")
        XCTAssertEqual(model.shortName("bot_9f3a"), "Bot 9f3a")
    }
}

// MARK: - Phase 4: the words in the feed

@MainActor
final class EventCopyTests: XCTestCase {
    private let naming = EventNaming(
        name: { $0 == "me" ? "You" : "Player \($0)" },
        isMe: { $0 == "me" }
    )

    func testTheVerbAgreesWithWhoItIsAbout() {
        // "You loses a die" is what third-person copy does to a second-person name. Both of these
        // appeared on a real device before the feed learned to conjugate.
        let lost = ProtocolEvent.dieLost(.init(playerId: "me", diceCount: 3))
        XCTAssertEqual(lost.summary(naming), "You lose a die — 3 left")

        let theirs = ProtocolEvent.dieLost(.init(playerId: "dana", diceCount: 3))
        XCTAssertEqual(theirs.summary(naming), "Player dana loses a die — 3 left")

        let dudo = ProtocolEvent.dudoCalled(
            .init(playerId: "me", bidderId: "dana", bid: Bid(quantity: 4, face: .three))
        )
        XCTAssertEqual(dudo.summary(naming), "You challenge Player dana's 4 threes")

        let against = ProtocolEvent.dudoCalled(
            .init(playerId: "dana", bidderId: "me", bid: Bid(quantity: 4, face: .three))
        )
        XCTAssertEqual(against.summary(naming), "Player dana challenges your 4 threes")
    }

    func testTheFeedSaysFacesInWordsRatherThanGlyphs() {
        // The Unicode die faces are missing from the system font and render as ▫ on device.
        let revealed = ProtocolEvent.diceRevealed(
            .init(
                reveal: RevealSummary(
                    roundIndex: 0,
                    challengerId: "me",
                    bidderId: "dana",
                    bid: Bid(quantity: 4, face: .three),
                    wildOnes: true,
                    actualCount: 4,
                    bidStands: true,
                    hands: ["me": [.three], "dana": [.one]],
                    loserId: "me",
                    loserDiceCount: 4,
                    eliminatedId: nil
                )
            )
        )
        XCTAssertEqual(revealed.summary(naming), "Revealed: 4 threes — the bid was good")
        for scalar in "⚀⚁⚂⚃⚄⚅" {
            XCTAssertFalse(revealed.summary(naming).contains(scalar))
        }
    }

    func testEveryEventVariantSaysSomething() {
        let events: [ProtocolEvent] = [
            .matchStarted(.init(playerIds: ["me", "dana"], startingDice: 5)),
            .roundStarted(.init(index: 2, starterId: "me", palifico: true, diceCounts: ["me": 1])),
            .bidMade(.init(playerId: "me", bid: Bid(quantity: 2, face: .six))),
            .playerEliminated(.init(playerId: "me")),
            .palificoArmed(.init(playerId: "dana")),
            .matchEnded(.init(winnerId: "me")),
            .playerTimedOut(.init(playerId: "dana", consecutive: 1, autoBid: Bid(quantity: 1, face: .two))),
            .playerDisconnected(.init(playerId: "dana", graceMs: 45_000)),
            .playerReconnected(.init(playerId: "dana")),
            .botTookOver(.init(playerId: "me", reason: .afk)),
            .controlReturned(.init(playerId: "me")),
            .matchAbandoned(.init(reason: "allHumansDisconnected")),
        ]
        for event in events {
            let text = event.summary(naming)
            XCTAssertFalse(text.isEmpty, "\(event.type) has no copy")
            XCTAssertFalse(text.contains("Optional("), "\(event.type) leaked an Optional")
        }
        XCTAssertEqual(
            ProtocolEvent.matchEnded(.init(winnerId: "me")).summary(naming),
            "You win"
        )
        XCTAssertEqual(
            ProtocolEvent.roundStarted(
                .init(index: 2, starterId: "me", palifico: true, diceCounts: [:])
            ).summary(naming),
            "Round 3: PALIFICO, You opens"
        )
    }

    func testARefusalAlwaysHasSomethingReadableToSay() {
        for code in [ErrorCode.bidTooLow, .notYourTurn, .palificoFaceLocked, .rateLimited] {
            XCTAssertFalse(code.readable.isEmpty)
            XCTAssertFalse(code.readable.contains("_"), "\(code) shows a raw reason code")
        }
    }
}

@MainActor
final class PluralisationTests: XCTestCase {
    func testOneOfAFaceIsSingular() {
        // "Revealed: 1 threes" and "bids 1 fours" both reached a screenshot before this existed.
        XCTAssertEqual(Bid(quantity: 1, face: .four).spoken, "1 four")
        XCTAssertEqual(Bid(quantity: 4, face: .four).spoken, "4 fours")
        XCTAssertEqual(Face.three.spoken(count: 1), "1 three")
        XCTAssertEqual(Face.three.spoken(count: 0), "0 threes")
        XCTAssertEqual(Face.six.spoken(count: 2), "2 sixes")
    }

    func testTheFeedSaysOneOfAFaceProperly() {
        let event = ProtocolEvent.bidMade(.init(playerId: "p", bid: Bid(quantity: 1, face: .four)))
        XCTAssertEqual(event.summary(), "p bids 1 four")
    }
}
