import SwiftUI

/// Picks the screen. Every branch is a stage the session can actually be in, so an unhandled state
/// is a compile error rather than a blank view.
///
/// The states that are not "playing" matter more than they look. A player meets the connecting
/// state, the empty queue and the reconnection banner on their worst day — the day the network is
/// bad — and those are the screens that decide whether they come back.
struct RootView: View {
    let session: GameSession
    var preferences = Preferences()

    @State private var showOnboarding = false
    @State private var showJoin = false

    var body: some View {
        ZStack {
            FeltBackground()
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            if session.reconnecting {
                ReconnectingBanner()
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .foregroundStyle(Theme.ink)
        .animation(.snappy, value: session.reconnecting)
        .fullScreenCover(isPresented: $showOnboarding) {
            OnboardingView {
                preferences.hasSeenOnboarding = true
                showOnboarding = false
            }
        }
        .sheet(isPresented: $showJoin) {
            JoinPrivateGameView(
                join: { code in
                    session.joinParty(code: code)
                    showJoin = false
                },
                cancel: { showJoin = false },
                lastError: session.lastError
            )
        }
        .onAppear {
            showOnboarding = !preferences.hasSeenOnboarding
            Haptics.shared.warmUp()
        }
    }

    @ViewBuilder
    private var content: some View {
        switch session.stage {
        case .idle, .connecting:
            TableMessage(
                symbol: "dice.fill",
                title: "Shaking the cups…",
                detail: "Connecting to the table."
            ) {
                ProgressView().tint(Theme.brass)
            }

        case .lobby:
            LobbyView(
                session: session,
                showRules: { showOnboarding = true },
                showJoin: { showJoin = true }
            )

        case .party(let party):
            PrivateGameView(
                party: party,
                myPlayerId: session.playerId ?? "",
                start: { fillWithBots in session.startParty(fillWithBots: fillWithBots) },
                leave: { session.leaveParty() },
                lastError: session.lastError
            )

        case .queued(let waiting, let target, let backfillInMs):
            QueueView(
                waiting: waiting,
                target: target,
                backfillInMs: backfillInMs,
                cancel: { session.cancelQueue() }
            )

        case .playing:
            if let match = session.match {
                MatchView(match: match, leave: { session.leaveMatch() })
            } else {
                TableMessage(
                    symbol: "dice.fill",
                    title: "Dealing…",
                    detail: "Waiting for the first roll."
                ) {
                    ProgressView().tint(Theme.brass)
                }
            }

        case .needsUpdate(let serverVersion):
            TableMessage(
                symbol: "arrow.down.circle.fill",
                title: "Time to update",
                detail: """
                    This build speaks protocol \(protocolVersion) and the table speaks \
                    \(serverVersion). Update the app to play.
                    """
            ) { EmptyView() }

        case .failed(let reason):
            TableMessage(
                symbol: "wifi.exclamationmark",
                title: "Cannot reach the table",
                detail: reason
            ) {
                Button("Try again") { Task { await session.connect() } }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.brass)
            }
        }
    }
}

/// The shape every non-playing screen takes: a symbol, a sentence, and at most one thing to do.
struct TableMessage<Action: View>: View {
    let symbol: String
    let title: String
    let detail: String
    @ViewBuilder var action: Action

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 44))
                .foregroundStyle(Theme.brass)
            Text(title)
                .font(.system(.title2, design: .serif, weight: .semibold))
            Text(detail)
                .font(.callout)
                .foregroundStyle(Theme.inkSoft)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            action
                .padding(.top, 4)
        }
        .padding(32)
        .accessibilityElement(children: .contain)
    }
}

/// R-18 made visible. The server holds a seat for 45 seconds, so the honest thing to show is that
/// we are trying — not an error, and not nothing at all.
struct ReconnectingBanner: View {
    var body: some View {
        VStack {
            HStack(spacing: 8) {
                ProgressView().tint(Theme.ink).controlSize(.small)
                Text("Reconnecting — your seat is held for a moment")
                    .font(.footnote)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Theme.leather.opacity(0.95), in: .capsule)
            .overlay(Capsule().strokeBorder(.white.opacity(0.12)))
            .padding(.top, 8)
            Spacer()
        }
        .accessibilityAddTraits(.updatesFrequently)
    }
}

struct LobbyView: View {
    let session: GameSession
    let showRules: () -> Void
    let showJoin: () -> Void

    var body: some View {
        VStack(spacing: 22) {
            VStack(spacing: 6) {
                Image(systemName: "dice.fill")
                    .font(.system(size: 52))
                    .foregroundStyle(Theme.brass)
                Text("Liar's Dice")
                    .font(.system(size: 38, design: .serif).weight(.bold))
            }

            Text("Five dice each. Everyone bids on what the whole table is hiding.")
                .font(.callout)
                .foregroundStyle(Theme.inkSoft)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 36)

            Button("Find a match") { session.findMatch() }
                .buttonStyle(.borderedProminent)
                .tint(Theme.brass)
                .controlSize(.large)

            // Private games sit under the public queue rather than beside it: most sessions
            // start with "find me anyone", and the friends flow is the deliberate detour.
            HStack(spacing: 10) {
                Button("Play with friends") { session.createParty() }
                    .buttonStyle(.bordered)
                    .tint(Theme.brass)
                Button("Join with a code", action: showJoin)
                    .buttonStyle(.bordered)
                    .tint(Theme.brass)
            }
            .controlSize(.regular)

            Button("How to play", action: showRules)
                .font(.footnote)
                .foregroundStyle(Theme.inkSoft)

            if let error = session.lastError {
                Label(error.readable, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(Theme.alarm)
                    .padding(.top, 4)
            }
        }
        .padding()
    }
}

/// The empty state that gets seen most: waiting for a table to fill.
struct QueueView: View {
    let waiting: Int
    let target: Int
    let backfillInMs: Int
    let cancel: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            // Seats filling up, drawn rather than described.
            HStack(spacing: 10) {
                ForEach(0..<target, id: \.self) { index in
                    Circle()
                        .fill(index < waiting ? Theme.brass : .white.opacity(0.12))
                        .frame(width: 14, height: 14)
                }
            }
            .accessibilityLabel("\(waiting) of \(target) seats filled")

            Text("Waiting for players")
                .font(.system(.title2, design: .serif, weight: .semibold))
            Text("\(waiting) of \(target) seats filled")
                .font(.callout)
                .foregroundStyle(Theme.inkSoft)
            // PLAN.md: a short queue is topped up with bots rather than left hanging.
            Text("Bots sit in after \(max(1, backfillInMs / 1000))s so you are not left waiting.")
                .font(.caption)
                .foregroundStyle(Theme.inkSoft)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)

            Button("Leave the queue", role: .cancel, action: cancel)
                .font(.footnote)
                .foregroundStyle(Theme.inkSoft)
                .padding(.top, 6)
        }
        .padding()
    }
}
