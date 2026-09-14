import SwiftUI

/// The table. Unstyled on purpose — Phase 4 is where this becomes a product; Phase 3 only has
/// to be *right*.
///
/// The view holds no state of its own beyond what it reads from the view model, and it decides
/// nothing: which buttons are live comes from `match.canBid` / `match.canChallenge`, which in
/// turn come from the server's `bidOptions`. A disabled control is a hint, and the server
/// re-validates regardless.
struct MatchView: View {
    let match: MatchViewModel
    let leave: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            seats
            if let reveal = match.revealOnShow {
                RevealPanel(reveal: reveal, myPlayerId: match.myPlayerId)
            } else if let winnerId = match.winnerId {
                WinnerPanel(winnerId: winnerId, iWon: match.iWon, leave: leave)
            } else {
                bidding
            }
            Divider()
            feed
        }
        .padding()
    }

    // MARK: - Pieces

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Round \(match.roundNumber)").font(.headline)
                if match.isPalifico {
                    Text("PALIFICO")
                        .font(.caption.bold())
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.yellow.opacity(0.3), in: .capsule)
                }
                Spacer()
                Text("\(match.totalDiceInPlay) dice in play")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 6) {
                Text("Your dice:").font(.subheadline)
                // R-03: the only hand any client is ever sent before a reveal.
                Text(match.myDice.map(\.glyph).joined(separator: " "))
                    .font(.title2)
                    .accessibilityLabel(match.myDice.map(\.spoken).joined(separator: ", "))
            }
            if let locked = match.lockedFace {
                Text("Face locked to \(locked.glyph) for this round")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var seats: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(match.players, id: \.id) { player in
                HStack(spacing: 8) {
                    Text(player.id == match.turnHolder ? "▶" : " ")
                    Text(player.id == match.myPlayerId ? "You" : player.id)
                        .fontWeight(player.id == match.myPlayerId ? .semibold : .regular)
                    if player.eliminated {
                        Text("out").font(.caption).foregroundStyle(.secondary)
                    } else {
                        Text(String(repeating: "▪", count: player.diceCount))
                            .foregroundStyle(.secondary)
                    }
                    if let seat = match.seat(of: player.id) {
                        if seat.control == .bot {
                            Text("bot").font(.caption2).foregroundStyle(.orange)
                        } else if !seat.connected {
                            Text("offline").font(.caption2).foregroundStyle(.red)
                        }
                    }
                    Spacer()
                }
                .font(.subheadline)
            }
        }
    }

    @ViewBuilder
    private var bidding: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let standing = match.standingBid {
                Text("Standing bid: \(standing.short) — \(standing.spoken)")
                    .font(.subheadline)
            } else {
                Text("No bid yet — the opener must bid").font(.subheadline)
            }

            if match.iAmBotControlled {
                Text("A bot is playing your seat.").foregroundStyle(.orange)
            } else if match.isMyTurn {
                yourTurn
            } else if let holder = match.turnHolder {
                HStack {
                    Text("Waiting for \(holder)…").foregroundStyle(.secondary)
                    if let remaining = match.turnEndsInMs {
                        Text("\(remaining / 1000)s").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }

            if let rejection = match.rejection {
                Text(rejection.readable).font(.caption).foregroundStyle(.red)
            }
        }
    }

    private var yourTurn: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Your turn").font(.headline)
                if let remaining = match.turnEndsInMs {
                    // R-16: a 30-second turn, enforced by the server. Phase 4 makes this a ring.
                    Text("\(remaining / 1000)s left")
                        .font(.caption)
                        .foregroundStyle(remaining < 10_000 ? .red : .secondary)
                }
            }

            // The face picker offers only faces the server says can be bid. During a palifico
            // round that is a single face (R-13); off a maximal ones bid it is none at all
            // (R-09's dead end), and then challenging is the only move left.
            HStack(spacing: 8) {
                ForEach(match.biddableFaces, id: \.self) { face in
                    Button(face.glyph) { match.choose(face: face) }
                        .font(.title3)
                        .buttonStyle(.bordered)
                        .tint(face == match.draftFace ? .accentColor : .gray)
                        .accessibilityLabel(face.spoken)
                }
            }

            HStack(spacing: 12) {
                Button("−") { match.nudgeQuantity(by: -1) }
                    .buttonStyle(.bordered)
                    .accessibilityLabel("fewer dice")
                Text("\(match.draftQuantity) × \(match.draftFace.glyph)")
                    .font(.title3.monospacedDigit())
                    .frame(minWidth: 90)
                Button("+") { match.nudgeQuantity(by: 1) }
                    .buttonStyle(.bordered)
                    .accessibilityLabel("more dice")
            }

            HStack(spacing: 12) {
                Button("Bid") { match.submitBid() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!match.canBid)
                Button("Dudo") { match.callDudo() }
                    .buttonStyle(.bordered)
                    .tint(.red)
                    .disabled(!match.canChallenge)
            }
        }
    }

    private var feed: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(match.log.suffix(12).enumerated()), id: \.offset) { entry in
                    Text(entry.element.summary)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 160)
    }
}

/// R-10: the one moment every hand is public.
struct RevealPanel: View {
    let reveal: RevealSummary
    let myPlayerId: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Reveal").font(.headline)
            Text("\(reveal.challengerId) called dudo on \(reveal.bidderId)'s \(reveal.bid.spoken)")
                .font(.subheadline)
            if !reveal.wildOnes {
                Text("Ones are not wild this round").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(reveal.hands.keys.sorted(), id: \.self) { playerId in
                HStack(spacing: 6) {
                    Text(playerId == myPlayerId ? "You" : playerId)
                        .frame(width: 90, alignment: .leading)
                    Text((reveal.hands[playerId] ?? []).map(\.glyph).joined(separator: " "))
                }
                .font(.subheadline)
            }
            Text("\(reveal.actualCount) × \(reveal.bid.face.glyph) against a bid of \(reveal.bid.quantity)")
                .font(.subheadline.bold())
            Text(reveal.bidStands ? "The bid was good." : "The bid was a lie.")
                .foregroundStyle(reveal.bidStands ? .green : .red)
            Text("\(reveal.loserId) loses a die — \(reveal.loserDiceCount) left")
            if let eliminated = reveal.eliminatedId {
                Text("\(eliminated) is out").foregroundStyle(.red)
            }
        }
        .padding(10)
        .background(.quaternary, in: .rect(cornerRadius: 8))
    }
}

struct WinnerPanel: View {
    let winnerId: String
    let iWon: Bool
    let leave: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            Text(iWon ? "You win." : "\(winnerId) wins.")
                .font(.title2.bold())
            Button("Back to the lobby", action: leave)
                .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity)
        .padding()
        .background(.quaternary, in: .rect(cornerRadius: 8))
    }
}
