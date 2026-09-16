import SwiftUI

/// R-16's thirty seconds, drawn.
///
/// The server sends how long is left at the moment it builds the snapshot, and the client counts
/// down from there. That is deliberately *not* an absolute timestamp: a phone with a skewed clock
/// would draw the wrong ring, and the server remains the only thing that actually enforces the
/// deadline — this just shows it.
///
/// Swift note: `TimelineView(.animation)` re-renders on every frame while it is on screen, which
/// is what makes a smooth sweep possible without the view model owning a ticking timer.
struct TurnRing: View {
    /// When the turn runs out, in this device's clock.
    let deadline: Date
    /// The full length of a turn, so the ring knows what a full circle means.
    let total: TimeInterval
    var size: CGFloat = 34
    var showsSeconds = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: reduceMotion ? 1 : 1 / 30)) { context in
            let remaining = max(0, deadline.timeIntervalSince(context.date))
            let fraction = total > 0 ? min(1, remaining / total) : 0

            ZStack {
                Circle()
                    .stroke(.white.opacity(0.16), lineWidth: size * 0.12)
                Circle()
                    .trim(from: 0, to: fraction)
                    .stroke(
                        remaining <= 10 ? Theme.alarm : Theme.brass,
                        style: StrokeStyle(lineWidth: size * 0.12, lineCap: .round)
                    )
                    .rotationEffect(.degrees(-90))
                if showsSeconds {
                    Text("\(Int(remaining.rounded(.up)))")
                        .font(.system(size: size * 0.42, weight: .semibold, design: .serif))
                        .monospacedDigit()
                        .foregroundStyle(Theme.ink)
                }
            }
            .frame(width: size, height: size)
            .accessibilityLabel("\(Int(remaining.rounded(.up))) seconds left in this turn")
        }
    }
}

/// The cup that hides everyone's dice until R-10 says otherwise.
///
/// Lifting it is the first beat of the reveal: the thing the whole game is about is that nobody
/// can see under here, so the moment it rises should be the moment the table changes.
struct Cup: View {
    var size: CGFloat = 96
    /// 0 is resting on the felt, 1 is fully raised and out of the way.
    var lift: Double

    var body: some View {
        CupShape()
            .fill(
                LinearGradient(
                    colors: [Theme.leatherHighlight, Theme.leather],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
            .overlay {
                CupShape()
                    .strokeBorder(.black.opacity(0.28), lineWidth: 1.5)
            }
            .frame(width: size, height: size * 0.92)
            .shadow(color: .black.opacity(0.4 * (1 - lift * 0.6)), radius: 10, y: 8)
            .offset(y: -size * 1.15 * lift)
            .opacity(1 - lift * 0.85)
            .accessibilityHidden(true)
    }
}

/// A tapered cup: wide at the rim, narrower where it meets the table.
private struct CupShape: InsettableShape {
    var inset: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        let r = rect.insetBy(dx: inset, dy: inset)
        let taper = r.width * 0.14
        var path = Path()
        path.move(to: CGPoint(x: r.minX, y: r.minY))
        path.addLine(to: CGPoint(x: r.maxX, y: r.minY))
        path.addLine(to: CGPoint(x: r.maxX - taper, y: r.maxY))
        path.addLine(to: CGPoint(x: r.minX + taper, y: r.maxY))
        path.closeSubpath()
        return path
    }

    func inset(by amount: CGFloat) -> Self {
        var copy = self
        copy.inset += amount
        return copy
    }
}
