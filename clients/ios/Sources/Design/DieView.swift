import SwiftUI

/// A die, drawn rather than typed.
///
/// Phase 3 used the Unicode die glyphs, which are legible but tiny, unstyleable, and rendered
/// differently by every font. Drawing the pips means they scale crisply, can be highlighted
/// individually when a reveal counts them, and can be shown face-down for a hand that is not
/// ours to see.
struct DieView: View {
    let face: Face?
    var size: CGFloat = 44
    /// Drawn lit when this die counts toward the bid being challenged (R-07: a wild one counts).
    var counting = false
    /// Face-down: somebody else's die, or one not yet revealed.
    var hidden = false

    var body: some View {
        RoundedRectangle(cornerRadius: size * Theme.dieRadius, style: .continuous)
            .fill(hidden ? AnyShapeStyle(hiddenFill) : AnyShapeStyle(faceFill))
            .overlay {
                if hidden {
                    RoundedRectangle(cornerRadius: size * Theme.dieRadius, style: .continuous)
                        .strokeBorder(.white.opacity(0.14), lineWidth: 1)
                } else if let face {
                    Pips(face: face)
                        .fill(Theme.dicePip)
                        .padding(size * 0.14)
                }
            }
            .overlay {
                if counting {
                    RoundedRectangle(cornerRadius: size * Theme.dieRadius, style: .continuous)
                        .strokeBorder(Theme.brass, lineWidth: 2.5)
                }
            }
            .frame(width: size, height: size)
            .shadow(color: .black.opacity(0.35), radius: size * 0.09, x: 0, y: size * 0.06)
            .accessibilityLabel(accessibilityText)
    }

    private var faceFill: some ShapeStyle {
        LinearGradient(
            colors: [Theme.diceFace, Theme.diceFace.opacity(0.86)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    private var hiddenFill: some ShapeStyle {
        LinearGradient(
            colors: [Theme.leatherHighlight.opacity(0.55), Theme.leather.opacity(0.75)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    private var accessibilityText: String {
        if hidden { return "a hidden die" }
        guard let face else { return "a die" }
        return counting ? "\(face.spokenSingular), counting" : face.spokenSingular
    }
}

/// The pip layout for each face, on the usual 3×3 grid.
private struct Pips: Shape {
    let face: Face

    func path(in rect: CGRect) -> Path {
        let radius = min(rect.width, rect.height) * 0.105
        var path = Path()
        for spot in Self.layout(for: face) {
            let centre = CGPoint(
                x: rect.minX + rect.width * spot.x,
                y: rect.minY + rect.height * spot.y
            )
            path.addEllipse(
                in: CGRect(
                    x: centre.x - radius,
                    y: centre.y - radius,
                    width: radius * 2,
                    height: radius * 2
                )
            )
        }
        return path
    }

    /// Unit positions within the die. Left/centre/right by top/middle/bottom.
    private static func layout(for face: Face) -> [CGPoint] {
        let left = 0.22, mid = 0.5, right = 0.78
        let top = 0.22, centre = 0.5, bottom = 0.78
        switch face {
        case .one:
            return [CGPoint(x: mid, y: centre)]
        case .two:
            return [CGPoint(x: left, y: top), CGPoint(x: right, y: bottom)]
        case .three:
            return [
                CGPoint(x: left, y: top), CGPoint(x: mid, y: centre), CGPoint(x: right, y: bottom),
            ]
        case .four:
            return [
                CGPoint(x: left, y: top), CGPoint(x: right, y: top),
                CGPoint(x: left, y: bottom), CGPoint(x: right, y: bottom),
            ]
        case .five:
            return [
                CGPoint(x: left, y: top), CGPoint(x: right, y: top),
                CGPoint(x: mid, y: centre),
                CGPoint(x: left, y: bottom), CGPoint(x: right, y: bottom),
            ]
        case .six:
            return [
                CGPoint(x: left, y: top), CGPoint(x: right, y: top),
                CGPoint(x: left, y: centre), CGPoint(x: right, y: centre),
                CGPoint(x: left, y: bottom), CGPoint(x: right, y: bottom),
            ]
        }
    }
}

/// A hand of dice that tumbles into place when the round changes.
///
/// The roll is faked in the honest sense: the server already decided the faces (R-03, R-20), and
/// this only animates their arrival. Each die drops with its own delay and a little rotation, so
/// the hand lands as five separate objects rather than one block.
struct RolledHand: View {
    let dice: [Face]
    var size: CGFloat = 44
    /// Changing this re-runs the roll — the round index, in practice.
    var rollToken: Int
    var countingFace: Face?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var landed = false

    var body: some View {
        HStack(spacing: size * 0.18) {
            ForEach(Array(dice.enumerated()), id: \.offset) { index, face in
                DieView(face: face, size: size, counting: counts(face))
                    .rotationEffect(.degrees(landed || reduceMotion ? 0 : Double((index % 2 == 0 ? -1 : 1) * 38)))
                    .offset(y: landed || reduceMotion ? 0 : -size * 1.6)
                    .opacity(landed || reduceMotion ? 1 : 0)
                    .animation(
                        reduceMotion
                            ? nil
                            : Theme.Motion.roll.delay(Double(index) * Theme.Motion.rollStagger),
                        value: landed
                    )
            }
        }
        .onAppear { landed = true }
        .onChange(of: rollToken) {
            // Drop back out of frame and land again — a new round, a new roll.
            landed = false
            withAnimation(nil) {}
            DispatchQueue.main.async { landed = true }
        }
    }

    /// R-07: a one counts toward any face, but a bid *on* ones counts only ones. R-13 removed
    /// the round that used to suspend this, so there is no longer a flag to pass in.
    private func counts(_ face: Face) -> Bool {
        guard let countingFace else { return false }
        if face == countingFace { return true }
        return countingFace != .one && face == .one
    }
}
