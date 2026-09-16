import SwiftUI

/// The table.
///
/// The view decides nothing. Which controls are live comes from `match.canBid` / `canChallenge`,
/// which come from the server's `bidOptions`; what a reveal is showing comes from `match.revealBeat`.
/// A disabled control is a hint, and the server re-validates regardless.
struct MatchView: View {
    let match: MatchViewModel
    let leave: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            FeltBackground()

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    header
                    seats
                    Group {
                        if let reveal = match.revealOnShow {
                            RevealPanel(
                                reveal: reveal,
                                beat: match.revealBeat,
                                myPlayerId: match.myPlayerId,
                                name: match.shortName
                            )
                        } else if let winnerId = match.winnerId {
                            WinnerPanel(
                                name: match.shortName(winnerId),
                                iWon: match.iWon,
                                leave: leave
                            )
                        } else {
                            bidding
                        }
                    }
                    .transition(.opacity)
                    myHand
                    feed
                }
                .padding(18)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .motion(Theme.Motion.fade, reduced: reduceMotion, value: match.revealBeat)
        .motion(Theme.Motion.fade, reduced: reduceMotion, value: match.winnerId)
        .foregroundStyle(Theme.ink)
        .toolbarBackground(.hidden, for: .navigationBar)
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Round \(match.roundNumber)")
                    .font(.system(.title2, design: .serif, weight: .semibold))
                Text(match.totalDiceInPlay == 1 ? "1 die in play" : "\(match.totalDiceInPlay) dice in play")
                    .font(.caption)
                    .foregroundStyle(Theme.inkSoft)
            }
            Spacer()
            if match.isPalifico {
                PalificoBadge(lockedFace: match.lockedFace)
            }
        }
    }

    // MARK: - Seats

    private var seats: some View {
        VStack(spacing: 8) {
            ForEach(match.players, id: \.id) { player in
                SeatRow(
                    player: player,
                    name: match.shortName(player.id),
                    isMe: player.id == match.myPlayerId,
                    onTurn: player.id == match.turnHolder,
                    status: match.seat(of: player.id),
                    deadline: player.id == match.turnHolder ? match.turnDeadline : nil,
                    turnLength: match.turnLength
                )
            }
        }
    }

    // MARK: - Your hand

    private var myHand: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Your hand")
                .font(.caption.smallCaps())
                .foregroundStyle(Theme.inkSoft)
            if match.myDice.isEmpty {
                Text("You are out of this match.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.inkSoft)
            } else {
                RolledHand(
                    dice: match.myDice,
                    size: 46,
                    rollToken: match.rollToken,
                    countingFace: match.revealBeat >= .counting ? match.revealOnShow?.bid.face : nil,
                    wildOnes: match.revealOnShow?.wildOnes ?? false
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Bidding

    @ViewBuilder
    private var bidding: some View {
        TablePanel {
            VStack(alignment: .leading, spacing: 12) {
                if let standing = match.standingBid, let bidder = match.bidHistory.last?.playerId {
                    HStack(spacing: 8) {
                        Text("\(match.shortName(bidder)) bids")
                            .foregroundStyle(Theme.inkSoft)
                        BidChip(bid: standing)
                    }
                    .font(.subheadline)
                } else {
                    Text("No bid yet — whoever opens must bid.")
                        .font(.subheadline)
                        .foregroundStyle(Theme.inkSoft)
                }

                if match.iAmBotControlled {
                    Label("A bot is playing your seat", systemImage: "cpu")
                        .font(.subheadline)
                        .foregroundStyle(Theme.brass)
                } else if match.isMyTurn {
                    yourTurn
                } else if let holder = match.turnHolder {
                    Text("Waiting for \(match.shortName(holder))…")
                        .font(.subheadline)
                        .foregroundStyle(Theme.inkSoft)
                }

                if let rejection = match.rejection {
                    Label(rejection.readable, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(Theme.alarm)
                        .transition(.opacity)
                }
            }
        }
    }

    private var yourTurn: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let blocked = match.bidBlockedReason {
                // R-09's dead end, most often: no legal raise exists, so dudo is the only move.
                Label(blocked, systemImage: "info.circle")
                    .font(.caption)
                    .foregroundStyle(Theme.brass)
            } else {
                facePicker
                quantityStepper
            }
            actions
        }
    }

    private var facePicker: some View {
        HStack(spacing: 10) {
            ForEach(Face.allCases, id: \.self) { face in
                let available = match.minimumQuantity(for: face) != nil
                Button {
                    match.choose(face: face)
                } label: {
                    DieView(face: face, size: 40)
                        .opacity(available ? 1 : 0.28)
                        .overlay {
                            if face == match.draftFace {
                                RoundedRectangle(cornerRadius: 40 * Theme.dieRadius, style: .continuous)
                                    .strokeBorder(Theme.brass, lineWidth: 3)
                            }
                        }
                }
                .buttonStyle(.plain)
                .disabled(!available)
                .accessibilityLabel(face.spoken)
                .accessibilityHint(available ? "choose this face" : "cannot be bid right now")
            }
        }
    }

    private var quantityStepper: some View {
        HStack(spacing: 16) {
            stepperButton("minus", label: "fewer dice") { match.nudgeQuantity(by: -1) }
            HStack(spacing: 8) {
                Text("\(match.draftQuantity)")
                    .font(.system(.largeTitle, design: .serif, weight: .semibold))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                Text("×").foregroundStyle(Theme.inkSoft)
                DieView(face: match.draftFace, size: 34)
            }
            .frame(minWidth: 120)
            .animation(.snappy, value: match.draftQuantity)
            stepperButton("plus", label: "more dice") { match.nudgeQuantity(by: 1) }
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(match.draftQuantity) \(match.draftFace.spoken)")
    }

    private func stepperButton(_ symbol: String, label: String, action: @escaping () -> Void)
        -> some View
    {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.headline)
                .frame(width: 44, height: 44)
                .background(.white.opacity(0.10), in: .circle)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private var actions: some View {
        HStack(spacing: 12) {
            Button {
                match.submitBid()
            } label: {
                Text("Bid").frame(maxWidth: .infinity)
            }
            .buttonStyle(TableButton(tint: Theme.brass))
            .disabled(!match.canBid)

            Button {
                match.callDudo()
            } label: {
                Text("Dudo").frame(maxWidth: .infinity)
            }
            .buttonStyle(TableButton(tint: Theme.alarm))
            .disabled(!match.canChallenge)
            .accessibilityHint("call the current bid a lie")
        }
    }

    // MARK: - Feed

    private var feed: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(match.log.suffix(6).enumerated()), id: \.offset) { entry in
                Text(entry.element.summary(match.naming))
                    .font(.caption)
                    .foregroundStyle(Theme.inkSoft)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Pieces

private struct SeatRow: View {
    let player: PublicPlayer
    let name: String
    let isMe: Bool
    let onTurn: Bool
    let status: SeatStatus?
    let deadline: Date?
    let turnLength: TimeInterval

    var body: some View {
        HStack(spacing: 10) {
            if let deadline, onTurn {
                TurnRing(deadline: deadline, total: turnLength, size: 34)
            } else {
                Circle()
                    .fill(onTurn ? Theme.brass.opacity(0.4) : .white.opacity(0.08))
                    .frame(width: 34, height: 34)
            }

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(name)
                        .font(.subheadline.weight(isMe ? .semibold : .regular))
                        .lineLimit(1)
                    if status?.control == .bot {
                        Image(systemName: "cpu")
                            .font(.caption2)
                            .foregroundStyle(Theme.brass)
                            .accessibilityLabel("played by a bot")
                    } else if status?.connected == false {
                        Image(systemName: "wifi.slash")
                            .font(.caption2)
                            .foregroundStyle(Theme.alarm)
                            .accessibilityLabel("disconnected")
                    }
                }
                if player.eliminated {
                    Text("out")
                        .font(.caption)
                        .foregroundStyle(Theme.inkSoft)
                } else {
                    HStack(spacing: 4) {
                        ForEach(0..<player.diceCount, id: \.self) { _ in
                            DieView(face: nil, size: 14, hidden: true)
                        }
                    }
                    .accessibilityLabel(player.diceCount == 1 ? "1 die" : "\(player.diceCount) dice")
                }
            }
            Spacer()
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 10)
        .background(onTurn ? AnyShapeStyle(.white.opacity(0.07)) : AnyShapeStyle(.clear),
                    in: .rect(cornerRadius: 10))
    }
}

private struct BidChip: View {
    let bid: Bid

    var body: some View {
        HStack(spacing: 6) {
            Text("\(bid.quantity)")
                .font(.system(.title3, design: .serif, weight: .semibold))
                .monospacedDigit()
            Text("×").foregroundStyle(Theme.inkSoft)
            DieView(face: bid.face, size: 26)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.black.opacity(0.22), in: .capsule)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(bid.spoken)
    }
}

private struct PalificoBadge: View {
    let lockedFace: Face?

    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text("PALIFICO")
                .font(.caption.bold())
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Theme.brass.opacity(0.35), in: .capsule)
            // R-13, said as a situation rather than as a rule number.
            Text(lockedFace == nil ? "ones are not wild" : "ones are not wild · face locked")
                .font(.caption2)
                .foregroundStyle(Theme.inkSoft)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Palifico round. Ones are not wild and the face is locked.")
    }
}

private struct TableButton: ButtonStyle {
    let tint: Color
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .padding(.vertical, 12)
            .foregroundStyle(isEnabled ? Theme.ink : Theme.inkSoft)
            .background(
                (isEnabled ? tint.opacity(0.85) : Color.white.opacity(0.08)),
                in: .rect(cornerRadius: 12)
            )
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.snappy(duration: 0.12), value: configuration.isPressed)
    }
}

/// R-10, paced out. The cup comes up, the hands appear, the dice that count light up, and only
/// then is the verdict said out loud.
struct RevealPanel: View {
    let reveal: RevealSummary
    let beat: MatchViewModel.RevealBeat
    let myPlayerId: String
    let name: (String) -> String

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TablePanel {
            VStack(alignment: .leading, spacing: 12) {
                header
                if beat >= .hands {
                    hands.transition(.opacity.combined(with: .scale(scale: 0.96)))
                } else {
                    cup
                }
                if beat >= .verdict { verdict.transition(.opacity) }
                if beat >= .outcome { outcome.transition(.opacity) }
            }
        }
        .motion(Theme.Motion.settle, reduced: reduceMotion, value: beat)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(name(reveal.challengerId)) called dudo")
                .font(.system(.title3, design: .serif, weight: .semibold))
            HStack(spacing: 6) {
                Text("on \(name(reveal.bidderId))'s")
                    .foregroundStyle(Theme.inkSoft)
                BidChip(bid: reveal.bid)
            }
            .font(.subheadline)
            if !reveal.wildOnes {
                Text("Ones are not wild this round")
                    .font(.caption)
                    .foregroundStyle(Theme.inkSoft)
            }
        }
    }

    private var cup: some View {
        HStack {
            Spacer()
            Cup(size: 110, lift: reduceMotion ? 1 : (beat >= .hands ? 1 : 0))
                .animation(reduceMotion ? nil : Theme.Motion.cupLift, value: beat)
            Spacer()
        }
        .frame(height: 120)
    }

    private var hands: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(reveal.hands.keys.sorted(), id: \.self) { playerId in
                HStack(spacing: 10) {
                    Text(name(playerId))
                        .font(.caption)
                        .foregroundStyle(playerId == myPlayerId ? Theme.ink : Theme.inkSoft)
                        .frame(width: 74, alignment: .leading)
                        .lineLimit(1)
                    HStack(spacing: 6) {
                        ForEach(Array((reveal.hands[playerId] ?? []).enumerated()), id: \.offset) {
                            _, face in
                            DieView(face: face, size: 30, counting: beat >= .counting && counts(face))
                        }
                    }
                }
            }
        }
    }

    private var verdict: some View {
        HStack(spacing: 8) {
            Text("\(reveal.actualCount)")
                .font(.system(.title, design: .serif, weight: .bold))
                .monospacedDigit()
            Text("×")
                .foregroundStyle(Theme.inkSoft)
            DieView(face: reveal.bid.face, size: 28)
            Text("against a bid of \(reveal.bid.quantity)")
                .foregroundStyle(Theme.inkSoft)
            Spacer()
            Text(reveal.bidStands ? "Good bid" : "A lie")
                .font(.headline)
                .foregroundStyle(reveal.bidStands ? Theme.good : Theme.alarm)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(reveal.bid.face.spoken(count: reveal.actualCount)) against a bid of \(reveal.bid.quantity). "
                + (reveal.bidStands ? "The bid was good." : "The bid was a lie.")
        )
    }

    private var outcome: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(
                "\(name(reveal.loserId)) loses a die — \(reveal.loserDiceCount) left",
                systemImage: "minus.circle.fill"
            )
            .foregroundStyle(Theme.alarm)
            if let eliminated = reveal.eliminatedId {
                Label("\(name(eliminated)) is out", systemImage: "xmark.circle.fill")
                    .font(.subheadline.bold())
                    .foregroundStyle(Theme.alarm)
            }
        }
        .font(.subheadline)
    }

    /// R-07: a wild one counts toward the bid face, but a bid on ones counts only ones.
    private func counts(_ face: Face) -> Bool {
        if face == reveal.bid.face { return true }
        return reveal.wildOnes && reveal.bid.face != .one && face == .one
    }
}

struct WinnerPanel: View {
    let name: String
    let iWon: Bool
    let leave: () -> Void

    var body: some View {
        TablePanel(tint: iWon ? Theme.brass : .black) {
            VStack(spacing: 14) {
                Image(systemName: iWon ? "crown.fill" : "flag.checkered")
                    .font(.system(size: 40))
                    .foregroundStyle(iWon ? Theme.brass : Theme.inkSoft)
                Text(iWon ? "You win." : "\(name) wins.")
                    .font(.system(.title, design: .serif, weight: .bold))
                Button("Back to the lobby", action: leave)
                    .buttonStyle(TableButton(tint: Theme.brass))
            }
            .frame(maxWidth: .infinity)
        }
    }
}
