import SwiftUI

/// Picks the screen. Every branch is a stage the session can actually be in, so an unhandled
/// state is a compile error rather than a blank view.
///
/// Swift note: `some View` is an opaque return type — "a view, and the compiler knows which one,
/// but the caller does not have to". It is how SwiftUI avoids type-erasing every hierarchy.
struct RootView: View {
    let session: GameSession

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Liar's Dice")
                .toolbar {
                    if session.reconnecting {
                        ToolbarItem(placement: .topBarTrailing) {
                            Label("Reconnecting", systemImage: "arrow.triangle.2.circlepath")
                                .labelStyle(.titleAndIcon)
                                .font(.caption)
                        }
                    }
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch session.stage {
        case .idle, .connecting:
            ProgressView("Connecting…")

        case .lobby:
            LobbyView(session: session)

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
                ProgressView("Dealing…")
            }

        case .needsUpdate(let serverVersion):
            VStack(spacing: 12) {
                Text("Update needed").font(.headline)
                Text("This build speaks protocol \(protocolVersion); the server speaks \(serverVersion).")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }
            .padding()

        case .failed(let reason):
            VStack(spacing: 12) {
                Text("Cannot reach the server").font(.headline)
                Text(reason).font(.caption).foregroundStyle(.secondary)
                Button("Try again") { Task { await session.connect() } }
            }
            .padding()
        }
    }
}

struct LobbyView: View {
    let session: GameSession

    var body: some View {
        VStack(spacing: 20) {
            Text("Ready to play").font(.title2)
            if let playerId = session.playerId {
                Text("You are \(playerId)").font(.caption).foregroundStyle(.secondary)
            }
            Button("Find a match") { session.findMatch() }
                .buttonStyle(.borderedProminent)
            if let error = session.lastError {
                Text(error.readable).font(.caption).foregroundStyle(.red)
            }
        }
        .padding()
    }
}

struct QueueView: View {
    let waiting: Int
    let target: Int
    let backfillInMs: Int
    let cancel: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            ProgressView()
            Text("Waiting for players — \(waiting) of \(target)")
            // PLAN.md: a short queue is topped up with bots rather than left hanging.
            Text("Bots fill in after \(backfillInMs / 1000)s")
                .font(.caption)
                .foregroundStyle(.secondary)
            Button("Cancel", role: .cancel, action: cancel)
        }
        .padding()
    }
}
