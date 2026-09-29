import SwiftUI

/// A private game, waiting to start.
///
/// The screen has one job above all others: make the code easy to read out loud. Everything else
/// — who is here, who is missing, what the button will do — is secondary to a player holding a
/// phone and saying four characters to someone across a room or down a call.
struct PrivateGameView: View {
    let party: ServerMessage.PartyState
    let myPlayerId: String
    let start: (Bool) -> Void
    let leave: () -> Void
    let lastError: ErrorCode?

    /// Most private games are two or three friends who still want a full table.
    @State private var fillWithBots = true

    private var isHost: Bool { party.hostId == myPlayerId }
    private var canStart: Bool { party.members.count >= party.minSize }
    /// No empty seats left, so there is nothing for a bot to fill.
    private var full: Bool { party.members.count >= party.maxSize }

    var body: some View {
        VStack(spacing: 20) {
            code

            TablePanel {
                VStack(alignment: .leading, spacing: 10) {
                    Text("AT THE TABLE")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Theme.inkSoft)
                    ForEach(party.members, id: \.self) { member in
                        HStack(spacing: 10) {
                            Circle()
                                .fill(Theme.brass)
                                .frame(width: 8, height: 8)
                            Text(shortName(member, me: myPlayerId))
                                .font(.callout)
                            if member == party.hostId {
                                Text("host")
                                    .font(.caption2)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Theme.brass.opacity(0.28), in: .capsule)
                            }
                            Spacer()
                        }
                    }
                    // Empty chairs, so "we are waiting for someone" is visible rather than implied.
                    ForEach(party.members.count..<party.maxSize, id: \.self) { _ in
                        HStack(spacing: 10) {
                            Circle()
                                .strokeBorder(.white.opacity(0.18))
                                .frame(width: 8, height: 8)
                            Text("empty")
                                .font(.callout)
                                .foregroundStyle(Theme.inkSoft.opacity(0.7))
                            Spacer()
                        }
                    }
                }
            }

            if isHost {
                VStack(spacing: 12) {
                    // A named choice rather than a toggle, matching the web client. A toggle
                    // states one option and leaves you to infer the other; here both outcomes
                    // are on screen and the one that will happen is the one that is selected.
                    //
                    // Swift note: `Picker` with `.segmented` binds to any `Hashable` — the tags
                    // below are `Bool`, so the binding is the same `fillWithBots` the button
                    // sends. No separate enum to keep in step.
                    Picker("Who plays", selection: $fillWithBots) {
                        Text("Just us").tag(false)
                        Text(full ? "Table is full" : "Add bots").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .disabled(full)

                    Text(
                        fillWithBots && !full
                            ? "Empty seats are filled with bots."
                            : "\(party.members.count) player\(party.members.count == 1 ? "" : "s"), nobody else."
                    )
                    .font(.caption)
                    .foregroundStyle(Theme.inkSoft)

                    Button(canStart ? "Start the match" : "Waiting for one more") {
                        start(fillWithBots && !full)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.brass)
                    .controlSize(.large)
                    .disabled(!canStart)
                }
                .padding(.horizontal, 8)
            } else {
                Text("Waiting for \(shortName(party.hostId, me: myPlayerId)) to start the match.")
                    .font(.callout)
                    .foregroundStyle(Theme.inkSoft)
                    .multilineTextAlignment(.center)
            }

            Button("Leave", role: .cancel, action: leave)
                .font(.footnote)
                .foregroundStyle(Theme.inkSoft)

            if let lastError {
                Label(lastError.readable, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(Theme.alarm)
            }
        }
        .padding()
    }

    private var code: some View {
        VStack(spacing: 8) {
            Text("ROOM CODE")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.inkSoft)
            HStack(spacing: 8) {
                // Character by character, so nobody has to work out where one letter ends. The
                // alphabet has no O/0 or I/1 in it for the same reason.
                ForEach(Array(party.code.enumerated()), id: \.offset) { _, character in
                    Text(String(character))
                        .font(.system(size: 40, design: .monospaced).weight(.bold))
                        .frame(width: 48, height: 60)
                        .background(.black.opacity(0.22), in: .rect(cornerRadius: 10))
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Room code \(party.code.map(String.init).joined(separator: " "))")

            Button {
                UIPasteboard.general.string = party.code
                Haptics.shared.play(.bidPlaced)
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
                    .font(.footnote)
            }
            .foregroundStyle(Theme.inkSoft)
        }
    }
}

/// Where a code gets typed in.
///
/// The field normalises as you type — uppercasing and dropping anything outside the alphabet —
/// so a player who types lowercase, or pastes a code with a stray space, is never told their
/// input is malformed. The wire contract stays strict; the leniency lives here, which is the
/// right way round.
struct JoinPrivateGameView: View {
    let join: (String) -> Void
    let cancel: () -> Void
    let lastError: ErrorCode?

    @State private var typed = ""
    @FocusState private var focused: Bool

    var body: some View {
        ZStack {
            FeltBackground()
            VStack(spacing: 18) {
                Text("Join a private game")
                    .font(.system(.title2, design: .serif, weight: .semibold))
                Text("Ask whoever set it up for the four-character code.")
                    .font(.callout)
                    .foregroundStyle(Theme.inkSoft)
                    .multilineTextAlignment(.center)

                TextField("CODE", text: $typed)
                    .font(.system(size: 34, design: .monospaced).weight(.bold))
                    .multilineTextAlignment(.center)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .focused($focused)
                    .padding(.vertical, 12)
                    .background(.black.opacity(0.22), in: .rect(cornerRadius: 12))
                    .onChange(of: typed) { _, new in
                        let cleaned = GameSession.normalise(new)
                        if cleaned != new { typed = cleaned }
                    }
                    .onSubmit { submit() }

                Button("Join", action: submit)
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.brass)
                    .controlSize(.large)
                    .disabled(!GameSession.isCompleteCode(typed))

                Button("Cancel", role: .cancel, action: cancel)
                    .font(.footnote)
                    .foregroundStyle(Theme.inkSoft)

                if let lastError {
                    Label(lastError.readable, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(Theme.alarm)
                }
            }
            .padding(28)
        }
        .foregroundStyle(Theme.ink)
        .onAppear { focused = true }
    }

    private func submit() {
        guard GameSession.isCompleteCode(typed) else { return }
        join(typed)
    }
}
