# Liar's Dice

Real-time online multiplayer Liar's Dice. iOS first, then web, then Android.

## Start here

1. `CLAUDE.md` — architecture invariants, commands, and conventions. Read first.
2. `docs/RULES.md` — the canonical ruleset. The spec. Every rule has an ID.
3. `docs/PLAN.md` — stack rationale, infrastructure, and the phased roadmap.
4. `docs/KICKOFF_PROMPT.md` — the prompt to open Claude Code with, for Phases 0–1.
5. `docs/DECISIONS.md` — append-only architectural decision log.

## Status

**Phases 0 to 5 complete.** Every rule in `docs/RULES.md` is implemented and tested except
R-21, which the document itself marks v1.1.

| Package | What it is |
|---|---|
| `packages/engine` | The rules (R-01..R-15, R-20) as a pure deterministic reducer. Zero runtime dependencies. |
| `packages/protocol` | Zod schemas for every message. `PROTOCOL_VERSION = 1`. The source of truth for shape. |
| `apps/server` | WebSocket gateway, guest auth, matchmaker, room actors. Owns the clock and the sockets, so it owns R-16..R-19. |
| `tools/codegen` | Zod → JSON Schema → Swift. Generates `clients/ios/Sources/Generated/Protocol.swift`. |
| `packages/bots` | Bot policies. Binomial odds on the unseen dice, with a bluff rate. Takes a redacted view, so a bot cannot see the table. |
| `apps/cli` | Terminal client. A full match against the bots with no server involved. |
| `clients/ios` | SwiftUI app: guest auth, a `GameSocket` actor, and a themed, playable table with drawn dice, a paced reveal, a turn ring and haptics. |

## Playing it

The quickest way, no server and no Xcode:

```bash
pnpm install
pnpm cli                      # you against three bots, in the terminal
pnpm cli -- --seed 42         # reproduce a specific match
pnpm cli -- --players 6       # a six-handed table
pnpm cli -- --auto            # let a bot take your seat, to watch a match play out
```

Run the server:

```bash
cp apps/server/.env.example apps/server/.env    # AUTH_SECRET is generated in dev if unset
pnpm dev:server                                 # ws://localhost:8080, GET /health
```

The real app, against a local server, in one command:

```bash
pnpm play:ios                # builds, installs, launches, starts the server
                             # then tap "Find a match" — bots sit down after 5s
```

Build and test the iOS app by hand:

```bash
pnpm codegen                 # Swift models from packages/protocol — do this first
pnpm fixtures                # re-capture the server transcript the iOS tests decode
cd clients/ios && xcodegen generate
xcodebuild -scheme LiarsDice -destination 'platform=iOS Simulator,name=iPhone 17' test
```

Two simulators against your local server, which is how PLAN.md defines this phase as done:

```bash
# a two-player table, so two simulators fill it with no bots
MATCH_SIZE=2 AUTH_SECRET=$(openssl rand -hex 32) pnpm dev:server

xcrun simctl boot "iPhone 17" && xcrun simctl boot "iPhone 16e"
cd clients/ios && xcodegen generate
xcodebuild -scheme LiarsDice -configuration Debug -sdk iphonesimulator \
  -derivedDataPath /tmp/ld build CODE_SIGNING_ALLOWED=NO
for d in "iPhone 17" "iPhone 16e"; do
  xcrun simctl install "$d" /tmp/ld/Build/Products/Debug-iphonesimulator/LiarsDice.app
  # -autoQueue is a DEBUG-only launch flag: it presses "Find a match" for you
  xcrun simctl launch "$d" com.liarsdice.app -autoQueue YES
done
```

`clients/ios/Sources/Generated/` is gitignored on purpose: the Swift models are a build product
of the Zod schemas. Never hand-edit them, and never hand-edit `LiarsDice.xcodeproj` — edit
`clients/ios/project.yml` and regenerate.

Verify everything:

```bash
pnpm typecheck && pnpm lint && pnpm test
pnpm test:integration        # four clients, a full match, a disconnect and a resync
```

## Prerequisites

```bash
node -v          # 22+
pnpm -v          # 9+
brew install xcodegen    # needed from Phase 3
```
