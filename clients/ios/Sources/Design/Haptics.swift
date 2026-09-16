import SwiftUI
import UIKit

/// The feel of the game, since there is no sound yet.
///
/// With audio deferred (see docs/DECISIONS.md), haptics carry the whole burden of telling a player
/// that something happened without their having to read it. So this is a deliberate vocabulary
/// rather than a scattering of `.impact()` calls: each beat of a round has one feel, and the same
/// beat always feels the same.
///
/// Swift note: `@MainActor` because UIKit's feedback generators must be used from the main thread.
/// `prepare()` warms the Taptic Engine so the first tap is not late — without it the very first
/// haptic of a match arrives noticeably after the thing it is describing.
@MainActor
final class Haptics {
    /// One beat of the game.
    enum Beat {
        /// A die lands. Fired per die as a hand rolls in.
        case dieLanded
        /// Somebody raised.
        case bidPlaced
        /// Your turn began.
        case yourTurn
        /// Somebody called dudo — the moment the round turns.
        case challenge
        /// The cup comes up.
        case cupLift
        /// The bid was good, or it was a lie.
        case verdict(good: Bool)
        /// A die was taken off the table.
        case dieLost
        /// Somebody is out (R-12).
        case elimination
        /// The match is over, from this player's point of view.
        case matchOver(won: Bool)
        /// The server refused something.
        case rejected
    }

    static let shared = Haptics()

    private let light = UIImpactFeedbackGenerator(style: .light)
    private let medium = UIImpactFeedbackGenerator(style: .medium)
    private let heavy = UIImpactFeedbackGenerator(style: .heavy)
    private let rigid = UIImpactFeedbackGenerator(style: .rigid)
    private let soft = UIImpactFeedbackGenerator(style: .soft)
    private let notice = UINotificationFeedbackGenerator()

    /// Turned off wholesale when the player has asked for less motion, and by the preference.
    var enabled = true

    private init() {}

    /// Call before a burst — warming the engine is what keeps the first tap on time.
    func warmUp() {
        guard enabled else { return }
        for generator in [light, medium, heavy, rigid, soft] { generator.prepare() }
        notice.prepare()
    }

    func play(_ beat: Beat) {
        guard enabled else { return }
        switch beat {
        case .dieLanded:
            // Sharp and small: five of these in a row should read as five separate objects.
            rigid.impactOccurred(intensity: 0.7)
        case .bidPlaced:
            light.impactOccurred()
        case .yourTurn:
            soft.impactOccurred(intensity: 0.8)
        case .challenge:
            medium.impactOccurred()
        case .cupLift:
            soft.impactOccurred(intensity: 0.5)
        case .verdict(let good):
            notice.notificationOccurred(good ? .success : .warning)
        case .dieLost:
            heavy.impactOccurred()
        case .elimination:
            notice.notificationOccurred(.error)
        case .matchOver(let won):
            notice.notificationOccurred(won ? .success : .error)
        case .rejected:
            notice.notificationOccurred(.error)
        }
    }

    /// A hand landing: one tap per die, staggered to match the animation.
    func rollHand(count: Int) {
        guard enabled, count > 0 else { return }
        warmUp()
        for index in 0..<count {
            let delay = Double(index) * Theme.Motion.rollStagger
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.play(.dieLanded)
            }
        }
    }
}
