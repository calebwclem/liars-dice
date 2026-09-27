import SwiftUI

/// What a new player needs before their first hand.
///
/// Static copy, deliberately. A guided hand would have to be a real server match — the rules live
/// in `packages/engine` and CLAUDE.md keeps them out of the client — so a walkthrough belongs with
/// the practice mode in Phase 5. Four cards is enough to make the first round make sense; the rest
/// is taught by the table itself, through what it offers and what it refuses.
struct OnboardingView: View {
    let finish: () -> Void

    @State private var page = 0

    private struct Card {
        let title: String
        let body: String
        let art: AnyView
    }

    private var cards: [Card] {
        [
            Card(
                title: "Everyone rolls in secret",
                body: """
                    Five dice each, hidden under a cup. You can see your own hand and nobody \
                    else's — only how many dice they still have.
                    """,
                art: AnyView(
                    HStack(spacing: 8) {
                        DieView(face: .three, size: 46)
                        DieView(face: .five, size: 46)
                        DieView(face: nil, size: 46, hidden: true)
                        DieView(face: nil, size: 46, hidden: true)
                    }
                )
            ),
            Card(
                title: "A bid is a claim about the whole table",
                body: """
                    "Four fives" means you think there are at least four fives among everyone's \
                    dice — not just yours. Each player in turn must make a higher claim, or call \
                    the last one a lie.
                    """,
                art: AnyView(
                    HStack(spacing: 8) {
                        Text("4")
                            .font(.system(size: 44, design: .serif).weight(.bold))
                            .monospacedDigit()
                        Text("×").foregroundStyle(Theme.inkSoft)
                        DieView(face: .five, size: 46)
                    }
                )
            ),
            Card(
                title: "Ones are wild",
                // No Markdown in here. `Text` only parses it from a string *literal*
                // (a LocalizedStringKey); handed a String property it takes the plain overload,
                // so "*on*" reached the screen with its asterisks showing.
                body: """
                    A one counts as any face, so "four fives" is satisfied by fives and ones \
                    alike — in every round, right down to the last die on the table. Bidding on \
                    ones themselves is the one exception: that counts only real ones, which \
                    makes it a weak claim.
                    """,
                art: AnyView(
                    HStack(spacing: 8) {
                        DieView(face: .one, size: 46, counting: true)
                        Text("counts as").font(.caption).foregroundStyle(Theme.inkSoft)
                        DieView(face: .four, size: 46)
                    }
                )
            ),
            Card(
                title: "Challenging ends the round",
                body: """
                    Challenge a bid and every cup comes up. If the bid was good the challenger \
                    loses a die; if it was a lie the bidder does. Lose your last die and you are \
                    out — last player standing wins.
                    """,
                art: AnyView(
                    HStack(spacing: 10) {
                        Cup(size: 64, lift: 0)
                        Image(systemName: "arrow.right").foregroundStyle(Theme.inkSoft)
                        HStack(spacing: 5) {
                            DieView(face: .five, size: 30, counting: true)
                            DieView(face: .two, size: 30)
                            DieView(face: .one, size: 30, counting: true)
                        }
                    }
                )
            ),
        ]
    }

    var body: some View {
        ZStack {
            FeltBackground()
            VStack(spacing: 0) {
                TabView(selection: $page) {
                    // Identified by position, not by a generated id. `cards` is computed, so it
                    // minted a fresh UUID per card on every render — SwiftUI then saw four new
                    // pages each time and the selection wandered, landing a first-run player on
                    // the last card.
                    ForEach(Array(cards.enumerated()), id: \.offset) { index, card in
                        VStack(spacing: 24) {
                            Spacer()
                            card.art
                                .frame(height: 90)
                            Text(card.title)
                                .font(.system(.title2, design: .serif, weight: .semibold))
                                .multilineTextAlignment(.center)
                            Text(card.body)
                                .font(.callout)
                                .foregroundStyle(Theme.inkSoft)
                                .multilineTextAlignment(.center)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer()
                        }
                        .padding(.horizontal, 32)
                        .tag(index)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .always))
                .indexViewStyle(.page(backgroundDisplayMode: .always))

                Button(page == cards.count - 1 ? "Play" : "Next") {
                    if page == cards.count - 1 {
                        finish()
                    } else {
                        withAnimation { page += 1 }
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.brass)
                .controlSize(.large)
                .padding(.bottom, 12)

                Button("Skip", action: finish)
                    .font(.footnote)
                    .foregroundStyle(Theme.inkSoft)
                    .padding(.bottom, 24)
                    .opacity(page == cards.count - 1 ? 0 : 1)
                    .accessibilityHidden(page == cards.count - 1)
            }
        }
        .foregroundStyle(Theme.ink)
    }
}

/// Small persisted flags. Not secrets, not state the server cares about — just what this device
/// has already been told.
@MainActor
struct Preferences {
    private let seenOnboardingKey = "liarsdice.seenOnboarding"
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var hasSeenOnboarding: Bool {
        get { defaults.bool(forKey: seenOnboardingKey) }
        nonmutating set { defaults.set(newValue, forKey: seenOnboardingKey) }
    }
}
