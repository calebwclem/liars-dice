import SwiftUI

/// The look of the table, in one place.
///
/// A themed design does not get dark mode, Dynamic Type or Reduce Motion for free the way a
/// stock one does — every colour has to be defined for both appearances, every size has to scale
/// with the user's type setting, and every animation has to have an off switch. Keeping the
/// tokens here rather than scattering literals through the views is what makes that tractable.
enum Theme {
    // MARK: - Colour

    /// Two literal colours, resolved per appearance.
    ///
    /// Swift note: `UIColor { traits in ... }` is a *dynamic* colour — UIKit re-resolves it when
    /// the appearance changes, so a view built once still flips correctly between light and dark.
    private static func adaptive(light: UIColor, dark: UIColor) -> Color {
        Color(uiColor: UIColor { traits in traits.userInterfaceStyle == .dark ? dark : light })
    }

    /// The felt. Deeper and less saturated in the dark, where a bright green would glow.
    static let feltCentre = adaptive(
        light: UIColor(red: 0.13, green: 0.40, blue: 0.29, alpha: 1),
        dark: UIColor(red: 0.06, green: 0.19, blue: 0.15, alpha: 1)
    )
    static let feltEdge = adaptive(
        light: UIColor(red: 0.07, green: 0.26, blue: 0.19, alpha: 1),
        dark: UIColor(red: 0.03, green: 0.10, blue: 0.08, alpha: 1)
    )

    /// The rail around the table, and the cup.
    static let leather = adaptive(
        light: UIColor(red: 0.36, green: 0.22, blue: 0.14, alpha: 1),
        dark: UIColor(red: 0.24, green: 0.15, blue: 0.10, alpha: 1)
    )
    static let leatherHighlight = adaptive(
        light: UIColor(red: 0.52, green: 0.34, blue: 0.22, alpha: 1),
        dark: UIColor(red: 0.34, green: 0.22, blue: 0.15, alpha: 1)
    )

    /// Bone dice, a touch dimmer in the dark so they do not glare.
    static let diceFace = adaptive(
        light: UIColor(red: 0.97, green: 0.96, blue: 0.92, alpha: 1),
        dark: UIColor(red: 0.88, green: 0.87, blue: 0.83, alpha: 1)
    )
    static let dicePip = adaptive(
        light: UIColor(red: 0.16, green: 0.14, blue: 0.12, alpha: 1),
        dark: UIColor(red: 0.12, green: 0.11, blue: 0.09, alpha: 1)
    )

    /// Text on the felt.
    static let ink = adaptive(
        light: UIColor(red: 0.97, green: 0.96, blue: 0.93, alpha: 1),
        dark: UIColor(red: 0.90, green: 0.89, blue: 0.86, alpha: 1)
    )
    static let inkSoft = adaptive(
        light: UIColor(white: 1, alpha: 0.62),
        dark: UIColor(white: 1, alpha: 0.52)
    )

    /// Brass, for the turn ring and anything that wants attention without shouting.
    static let brass = adaptive(
        light: UIColor(red: 0.85, green: 0.68, blue: 0.33, alpha: 1),
        dark: UIColor(red: 0.78, green: 0.62, blue: 0.30, alpha: 1)
    )
    static let alarm = adaptive(
        light: UIColor(red: 0.85, green: 0.30, blue: 0.24, alpha: 1),
        dark: UIColor(red: 0.90, green: 0.38, blue: 0.32, alpha: 1)
    )
    static let good = adaptive(
        light: UIColor(red: 0.42, green: 0.76, blue: 0.47, alpha: 1),
        dark: UIColor(red: 0.45, green: 0.80, blue: 0.50, alpha: 1)
    )

    // MARK: - Shape

    static let panelRadius: CGFloat = 14
    static let dieRadius: CGFloat = 0.18 // as a fraction of the die's size

    // MARK: - Motion

    /// How long each beat takes. Gathered here so the reveal's pacing can be reasoned about as a
    /// whole rather than guessed at one `withAnimation` at a time.
    enum Motion {
        static let settle = Animation.spring(response: 0.42, dampingFraction: 0.66)
        static let quick = Animation.spring(response: 0.26, dampingFraction: 0.8)
        static let fade = Animation.easeInOut(duration: 0.22)
        /// One die landing. Staggered across a hand by `rollStagger`.
        static let roll = Animation.spring(response: 0.55, dampingFraction: 0.58)
        static let rollStagger: Double = 0.06
        static let cupLift = Animation.easeOut(duration: 0.55)
    }
}

/// A gradient that reads as a lit table rather than a flat fill.
struct FeltBackground: View {
    var body: some View {
        RadialGradient(
            colors: [Theme.feltCentre, Theme.feltEdge],
            center: .init(x: 0.5, y: 0.35),
            startRadius: 40,
            endRadius: 520
        )
        .overlay(alignment: .top) {
            // A soft light from above, so the table has a direction.
            LinearGradient(
                colors: [.white.opacity(0.07), .clear],
                startPoint: .top,
                endPoint: .center
            )
        }
        .ignoresSafeArea()
    }
}

/// A raised panel on the felt: the bid bar, the reveal, the winner.
struct TablePanel<Content: View>: View {
    var tint: Color = .black
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tint.opacity(0.24), in: .rect(cornerRadius: Theme.panelRadius))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.panelRadius)
                    .strokeBorder(.white.opacity(0.10), lineWidth: 1)
            )
    }
}

extension View {
    /// Apply an animation unless the player has asked the system for less motion.
    ///
    /// A felt table with tumbling dice is exactly the kind of interface that needs this: the
    /// motion is the point, and for some people it is also the problem.
    func motion(_ animation: Animation, reduced: Bool, value: some Equatable) -> some View {
        self.animation(reduced ? nil : animation, value: value)
    }
}
