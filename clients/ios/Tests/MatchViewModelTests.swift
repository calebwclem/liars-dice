import XCTest
@testable import LiarsDice

/// The table's view model. Every case here is about *presentation and intent* — whether a button
/// should be live, what the picker offers, which snapshot wins. The rules themselves are the
/// server's and are tested in `packages/engine`; if a test in this file starts needing to know
/// that ones are wild, something has leaked into the client.
@MainActor
final class MatchViewModelTests: XCTestCase {
    private var sent: [ClientMessage] = []

    private func makeModel(myPlayerId: String = "p1") -> MatchViewModel {
        sent = []
        return MatchViewModel(matchId: "m1", myPlayerId: myPlayerId) { [weak self] message in
            self?.sent.append(message)
        }
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

    private func state(_ snapshot: MatchSnapshot, seq: Int = 1, events: [ProtocolEvent] = [])
        -> ServerMessage.State
    {
        ServerMessage.State(kind: .update, matchId: "m1", seq: seq, events: events, snapshot: snapshot)
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
