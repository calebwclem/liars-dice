import Foundation

/// Where the guest token lives between launches.
///
/// PLAN.md's Phase 2 auth is an anonymous device account: the server hands back a signed token
/// on the first connect, and presenting it again restores the same identity — which is what
/// makes reconnecting into a match in progress work at all (R-18).
///
/// A protocol rather than a concrete type so tests can hand the session an in-memory store.
@MainActor
protocol TokenStore {
    func read() -> String?
    func write(_ token: String)
    func clear()
}

/// The real one. `UserDefaults` rather than the Keychain deliberately: a guest token grants
/// access to a throwaway identity with no personal data attached, and the Keychain's ceremony
/// buys nothing here. Phase 6 adds Sign in with Apple, and *that* credential belongs in the
/// Keychain.
@MainActor
struct UserDefaultsTokenStore: TokenStore {
    private let key = "liarsdice.guestToken"
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func read() -> String? {
        defaults.string(forKey: key)
    }

    func write(_ token: String) {
        defaults.set(token, forKey: key)
    }

    func clear() {
        defaults.removeObject(forKey: key)
    }
}

/// For tests and for previews.
@MainActor
final class InMemoryTokenStore: TokenStore {
    private var token: String?

    init(token: String? = nil) {
        self.token = token
    }

    func read() -> String? { token }
    func write(_ token: String) { self.token = token }
    func clear() { token = nil }
}
