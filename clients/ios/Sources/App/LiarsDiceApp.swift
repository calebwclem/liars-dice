import SwiftUI

/// Where the server is. Overridable at runtime so a device on the same network can point at a
/// Mac running `pnpm dev:server`, without a rebuild.
enum ServerEndpoint {
    static let defaultsKey = "liarsdice.serverURL"

    /// The simulator reaches the host Mac on 127.0.0.1, so this works out of the box there.
    static let fallback = URL(string: "ws://127.0.0.1:8080")!

    static func current(_ defaults: UserDefaults = .standard) -> URL {
        guard let text = defaults.string(forKey: defaultsKey), let url = URL(string: text) else {
            return fallback
        }
        return url
    }
}

@main
struct LiarsDiceApp: App {
    /// Swift note: `@State` on an `@Observable` class gives the app one instance that survives
    /// re-renders. SwiftUI then tracks exactly which of its properties each view reads.
    @State private var session = GameSession(
        endpoint: ServerEndpoint.current(),
        tokens: UserDefaultsTokenStore()
    )

    var body: some Scene {
        WindowGroup {
            RootView(session: session)
                .task { await session.connect() }
        }
    }
}
