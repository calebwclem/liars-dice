# Liar's Dice — Stack, Infrastructure, Roadmap

## The shape of the system

```
         ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
         │  iOS (Swift) │   │ Web (React)  │   │ Android (KT) │   thin clients:
         │   SwiftUI    │   │   Phase 8    │   │   Phase 9    │   render + intents
         └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
                └──────────────────┼──────────────────┘
                          WebSocket (JSON, versioned)
                                   │
                        ┌──────────▼───────────┐
                        │   apps/server (Node) │
                        │  gateway · matchmaker│
                        │  room actors · timers│
                        └───┬──────────┬───────┘
                            │          │
                  packages/engine   packages/bots      (pure, deterministic, shared)
                            │          │
                     ┌──────▼───┐  ┌───▼─────┐
                     │ Postgres │  │  Redis  │
                     └──────────┘  └─────────┘
```

## Stack choices and why

| Layer | Choice | Why |
|---|---|---|
| Rules engine | TypeScript, zero deps | Written once, runs on the server today and in the browser later for offline/practice mode. Pure + deterministic = trivially testable, which is exactly what an LLM coding agent needs to stay on the rails. |
| Protocol | Zod schemas → JSON | Runtime validation of every inbound message (you *must* validate; clients are hostile) plus a machine-readable schema to generate Swift/Kotlin types from. |
| Transport | Plain WebSockets (`ws`) | Turn-based game, ~1 message/turn. No need for Colyseus/Nakama/Photon — their value is tick loops and state sync you don't have. Fewer moving parts, and you learn the protocol design. |
| Server | Node 22 + TypeScript | Shares engine and protocol with web client. Excellent Claude Code support. Go would be a fine alternative but you'd lose type sharing. |
| Room model | One in-memory "room actor" per match, single-threaded event loop | Matches the engine's reducer shape exactly. Room state is ephemeral; only results are persisted. |
| Matchmaking | Redis sorted set queue + simple bucketing | Start dead simple: FIFO queue, fill to 4, 10s wait then backfill with bots. Skill-based matching later. |
| DB | Postgres (Neon or Fly Postgres) | Accounts, match results, stats. Not on the hot path. |
| Cache/queue | Redis (Upstash) | Matchmaking queue, room→machine routing, rate limiting, presence. |
| iOS | SwiftUI + Swift Concurrency, `URLSessionWebSocketTask` | Native, no dependencies, real iOS learning. `URLSessionWebSocketTask` is built in — no Starscream needed. |
| Xcode project | **XcodeGen** (`project.yml`) | Critical. Claude Code can safely edit YAML; it cannot safely edit `project.pbxproj`. Tuist is the heavier alternative if the project grows. |
| Dice visuals | 2D SwiftUI + Canvas/SpriteKit for the roll | Ship 2D. SceneKit/RealityKit 3D dice is a v2 polish item, not a v1 risk. |
| Auth | Anonymous device accounts first; Sign in with Apple at Phase 6 | Guest play removes all onboarding friction. Note: if you ever add Google/Facebook login, App Store rules require Sign in with Apple as an option too. |
| Hosting | Fly.io | First-class WebSocket support, cheap, easy multi-region later, and the `fly-replay` header lets you route a socket to the machine holding a given room when you scale past one instance. Railway/Render are fine simpler alternatives. |
| CI | GitHub Actions | TS tests on every push; macOS runner for `xcodebuild test`; fastlane → TestFlight on tag. |
| Errors/analytics | Sentry (server + iOS), PostHog | Add at Phase 4, not before. |

**Estimated running cost while you build and soft-launch: $5–20/month.**

## Why not one cross-platform framework?

React Native / Flutter / Unity would give you one UI codebase for all three targets. You
explicitly want to learn Swift and iOS, and the server-authoritative design means the UI
layer is the *only* thing duplicated — a dice table, a bid picker, and a results screen.
That's a few thousand lines per platform, and you don't pay it until Phases 8 and 9. If
after shipping iOS you'd rather not maintain three UIs, the engine/protocol packages
mean you can swap to a React Native client without touching the server at all.

## Roadmap (vertical slices)

Each phase ends with something you can actually run.

**Phase 0 — Foundation (½ day).** Monorepo, pnpm workspaces, TS config, Vitest, lint,
CI. `docs/RULES.md` reviewed and agreed. No game code.

**Phase 1 — Engine.** Pure reducer implementing every rule ID in `docs/RULES.md`.
Exhaustive unit tests + fast-check property tests. *Done when:* `pnpm cli` lets you play
a complete match in the terminal against random-action bots and someone wins.

**Phase 2 — Server.** WS gateway, Zod validation, guest auth (device token), room actor,
turn timers, redaction layer, matchmaking queue, reconnect/resync. *Done when:* an
integration test drives four in-process clients through a full match, one of which
disconnects mid-round and resyncs.

**Phase 3 — iOS vertical slice.** XcodeGen project, socket actor, generated models,
ugly-but-complete gameplay: queue → match → bid → challenge → reveal → win screen.
*Done when:* two simulators play each other against your local server.

**Phase 4 — Make it feel good.** Dice roll animation, cup lift, haptics, sound, turn
timer ring, reveal sequence, reconnection UX, onboarding/tutorial, empty and error
states. This is where the game becomes a product; budget real time here.

**Phase 5 — Bots.** Probability-based bot policy (binomial expectation on unseen dice,
with a bluff frequency parameter). Used for match backfill, AFK takeover, and an offline
practice mode.

**Phase 6 — Accounts and persistence.** Sign in with Apple, profiles, match history,
stats, simple ELO. Postgres schema + migrations.

**Phase 7 — Ship.** TestFlight beta, crash-free-rate gate, App Store Connect listing,
privacy nutrition labels, App Privacy details, age rating. **Keep the game free of any
wagering framing** — no chips, no pots, no "betting" copy, no purchasable currency used
to stake — so you avoid the simulated-gambling rating and the extra scrutiny that comes
with it. Guideline 4.7 and the gambling sections of the App Review Guidelines are worth
reading before you build the economy of any future version.

**Phase 8 — Web client.** *Done (2026-09-28), brought forward.* React + Vite, importing
`protocol` directly — no codegen, since it already speaks TypeScript. Built ahead of Phases 6
and 7 because playtesting with real people needed it: there is no way to hand someone an iOS
build without a developer account and Apple's review, and a URL needs neither. The server
changed in exactly one way: it serves `apps/web/dist` when present, so the page and the socket
share an origin.

**Phase 9 — Android.** Kotlin + Compose, models generated from the same protocol.

## Private games (landed 2026-09-28)

Players can create a party, share a four-character code, and start when everyone is in — with an
optional bot fill for empty seats. Built ahead of the Phase 8 web client because playtesting with
real people needs it: the public queue backfills with bots after ten seconds, so friends clicking
"find a match" at different moments never meet. See `docs/DECISIONS.md` for the shape.

This is also where a per-party ruleset selector belongs when the variants below are built — the
lobby is the one screen where a player can see what they are about to play before it starts.

## Web client backlog

Lives in `CLAUDE.md` rather than here, so every session sees it without being told. This file
keeps the phases and the parked ideas; that one keeps what is queued next for the browser.

## Rule variants (parked — not v1)

Palifico was removed on 2026-09-27 because the owner plays without it (see
`docs/DECISIONS.md`). The measurements taken at the time were interesting enough that it is
parked as a candidate *mode* rather than discarded: with palifico in force, a player down to one
die survived longer and won more often. The default ruleset is not in question — this is about
custom games later choosing something else.

**The hook already exists.** `MatchConfig` is carried on `GameState.config`, redacted into
`PlayerView.config`, and already decoded by the iOS client. A ruleset selector belongs there and
nowhere else — not a parallel system, not a server flag, not anything the client infers.

**Name the sets; do not ship a bag of toggles.** `rules: 'pirate' | 'perudo'` rather than five
independent booleans. Independent toggles multiply the test matrix and let players assemble
combinations nobody has ever played; a named set is one thing to test, one thing to explain in the
lobby, and one thing to write down in `docs/RULES.md`. If a third set is ever wanted, it gets a
name too.

**What a `perudo` set would have to restore**, all of it removed in one commit (`9c8195a`) and
liftable from `bbe6159` rather than rewritten:

- `RoundState.palifico`, `GameState.palificoNextFor`, `PlayerState.palificoUsed`,
  `PlayerView.round.lockedFace`, `RevealSummary.wildOnes`
- the `palificoArmed` event and the `PALIFICO_FACE_LOCKED` error
- the `wildOnes` parameter on `countFace` and `matchChance`
- R-09's ones conversions (halved quantity to reach ones, doubled to leave), removed separately
  on 2026-09-27 — full Perudo has both, so a faithful set cannot cherry-pick

**The invariant to protect.** `BidContext` is currently `{standing, diceInPlay}`, two public facts,
which is why the bid options handed to a client cannot encode anything about the cups. A variant
may add fields to it *only* if they are public too. The property test in
`packages/engine/test/properties.test.ts` that re-rolls every hand and asserts the options do not
move is the thing that must keep passing, under every ruleset.

**Where the work actually is.** Not the rules — those are in git. It is: config plumbing through
matchmaker and room; a lobby UI for custom games; and the test matrix, since every rule ID that
behaves differently per set now needs a test name per set, and `coverage.test.ts` enforces that
every ID is covered.

**Matchmaking stays single-ruleset.** Quick match uses the default and nothing else, or the queue
splits and wait times double for a feature most players will not touch. Variants belong to custom
or private games — which is also where the owner wants them.

**What the client should need to change: almost nothing.** `MatchView` renders `bidOptions` and has
no rules in it, so an entire alternate ruleset is invisible to it by construction. The exceptions
are copy, and they are the whole UX risk: the onboarding card that says ones are wild, the header
line that says the same, and whatever announces that this round is different. The lesson from the
version that shipped is that a rule a player meets for the first time *while it is being used
against them* is a bad rule however correct the engine is. A variant must be visible in the lobby
before the match starts.

## Things to get right early, cheaply

- **Protocol versioning from message #1.** Every client sends `protocolVersion` on
  connect; server rejects incompatible versions with a "please update" message. Retrofit
  this after launch and you'll regret it.
- **A `seq` number on every server state message**, so reconnect is "give me everything
  after seq N" rather than a guess.
- **Server-side turn timers**, never client-side.
- **Rate limiting and message size caps** on the socket from day one.
- **Structured logging with a `matchId`**, so you can reconstruct any reported bug.
- **Deterministic replay**: persist the action list per match. With a pure engine you can
  replay any match exactly — the single best debugging tool you will have.
