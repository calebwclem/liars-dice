# CLAUDE.md

Project: **Liar's Dice** — a real-time, online multiplayer dice game.
Ship order: iOS first, then web, then Android. One shared rules engine, thin clients.

The variant is **Pirate's Dice** (common-hand), not Perudo/Dudo: ones are wild in every
round, a raise must increase quantity or face, and there is no palifico and no calza.
`docs/RULES.md` is the authority and states the divergences deliberately — read it before
assuming a rule from another version of the game applies here.

The owner is an experienced programmer (Java/C++/Python/C) who is **new to Swift and
iOS**. When writing Swift, briefly explain idioms that differ from those languages
(optionals, value vs reference semantics, `@State`/`@Observable`, structured concurrency)
in comments or in your reply. Do not dumb down the code — explain it.

---

## Core architecture (do not violate)

1. **The server is authoritative.** All rules, all randomness, all validation.
2. **The client is a renderer.** `clients/ios` sends *intents* and draws *snapshots*.
   It contains zero rules logic. It never decides whether a bid is legal, who won a
   challenge, or what the dice are. It may *disable a button* for UX, but the server
   re-validates everything.
3. **The engine is pure.** `packages/engine` is a deterministic reducer:
   `reduce(state: GameState, action: Action, ctx: {now, rng}) -> {state, events[]}`.
   No `Date.now()`, no `Math.random()`, no I/O, no network, no DB, no logging. Time and
   randomness are injected via `ctx`. This makes every rule unit-testable.
4. **Redaction happens at the edge.** The server holds full state; before sending to a
   player it calls `redactFor(state, playerId)`. **A message must never contain another
   player's dice before a reveal.** There is a test asserting this; it must never be
   deleted or weakened.
5. **The protocol is the contract.** `packages/protocol` defines every message as a Zod
   schema. Swift models are **generated** from it — never hand-written.

## Repo layout

```
packages/engine/      Pure TS rules engine + exhaustive tests. No dependencies.
packages/protocol/    Zod schemas for all client<->server messages. Version constant.
packages/bots/        Bot policies (pure; take a redacted view, return an action).
apps/server/          WS gateway, matchmaker, room actors, persistence, auth.
apps/cli/             Terminal client. Play a match against the bots, no server.
apps/web/             React + Vite browser client. Served by apps/server when built.
clients/ios/          SwiftUI app. project.yml (XcodeGen) — see below.
tools/codegen/        protocol -> Swift/Kotlin model generation. iOS only; see below.
scripts/play-ios.sh   One command: codegen, build, boot a sim, start the server, launch.
scripts/play-web.sh   One command: build the web client, serve it, open a public tunnel.
docs/RULES.md         CANONICAL RULESET. The spec. Read it before touching the engine.
docs/PLAN.md          Phased roadmap, infrastructure, and parked ideas (rule variants).
docs/DECISIONS.md     Append-only log of architectural decisions.
docs/KICKOFF_PROMPT.md  The original brief. History, not a live spec.

Planned, not yet created: clients/android/ (Phase 9).
```

**The web client needs no codegen.** It imports `@liars-dice/protocol` directly and gets the
Zod schemas *and* the types — the generator exists because Swift cannot import TypeScript, not
because the protocol needs generating. So `pnpm codegen` is an iOS concern only, and a protocol
change reaches the browser the moment it typechecks.

`apps/server` serves `apps/web/dist` when it has been built, so the page and the WebSocket share
an origin. That is what lets one tunnel or one deploy carry a whole playable game, and why the
browser derives `wss://` from `location` instead of being configured.

Two build products that are not in git and must be regenerated rather than edited:
`clients/ios/Sources/Generated/` (`pnpm codegen`) and `clients/ios/*.xcodeproj`
(`xcodegen generate`). `clients/ios/Tests/Fixtures/transcript.json` *is* in git but is
also generated — see `pnpm fixtures` below.

## Commands

```bash
pnpm install                 # from repo root
pnpm test                    # all TS tests
pnpm --filter engine test    # engine tests only (fast — use this while iterating)
pnpm --filter engine test:prop  # property-based invariant tests
pnpm dev:server              # local server on :8080
pnpm cli                     # terminal client — play a full game against bots, no server
pnpm dev:web                 # browser client on :5173, talking to dev:server on :8080
pnpm build:web               # build apps/web/dist, which the server then serves
pnpm play:ios                # build, install and launch the app on a simulator, server and all
pnpm play:web                # build the web client, serve it, and tunnel it to a public URL
pnpm codegen                 # regenerate Swift/Kotlin models from packages/protocol
pnpm fixtures                # re-capture clients/ios/Tests/Fixtures/transcript.json
pnpm lint && pnpm typecheck && pnpm format:check   # all three before you call it done
```

**After any change to `packages/protocol`, run both `pnpm codegen` and `pnpm fixtures`.**
CI fails the iOS workflow if the captured transcript is stale, and it is easy to miss:
the TS tests all pass without it.

iOS (run from `clients/ios/`):

```bash
pnpm codegen                 # FIRST: Sources/Generated is a build product, not in git
xcodegen generate            # ALWAYS after adding/removing/renaming a Swift file
xcrun simctl list devices available | grep iPhone   # device names change with Xcode
xcodebuild -scheme LiarsDice -destination 'platform=iOS Simulator,name=iPhone 16e' build
xcodebuild -scheme LiarsDice -destination 'platform=iOS Simulator,name=iPhone 16e' test
```

**iPhone 17 is the owner's simulator — they play on it.** Build and test on **iPhone 16e**
instead, and never run `simctl shutdown all`, uninstall the app, or kill the dev server
without asking. A previous session did all three during a live match.

## Hard rules

- **Never hand-edit `.xcodeproj` / `project.pbxproj`.** It is generated. Edit
  `clients/ios/project.yml` and run `xcodegen generate`.
- **Never hand-edit generated Swift/Kotlin model files.** Edit the Zod schema in
  `packages/protocol` and run `pnpm codegen`.
- **Never add a dependency without asking.** The engine package must stay at zero
  runtime dependencies.
- **Never change `docs/RULES.md` to make a failing test pass.** If a rule is genuinely
  ambiguous or wrong, stop and ask; amend the doc deliberately, then fix the code.
- **Never put game logic in the iOS client.**
- **Never log or serialize hidden dice outside a reveal event.**
- No secrets in the repo. Server config comes from env vars, validated once at boot in
  `apps/server/src/env.ts`; see `apps/server/.env.example`.

## Workflow expectations

- **Test-first for the engine.** Write the failing test citing the rule ID from
  `docs/RULES.md` (e.g. `R-09`), then implement. Every rule ID must appear in at least
  one test name.
- **Work in vertical slices.** Finish one slice end-to-end before starting the next.
  Do not scaffold five half-built subsystems.
- **Run the tests before claiming anything works.** If you cannot run it, say so
  explicitly rather than asserting success.
- **Small commits**, conventional-commit messages (`feat(engine): bid options in snapshots`).
- When you make a non-obvious architectural choice, append a short entry to
  `docs/DECISIONS.md` (date, decision, alternatives considered, why).
- If a task is underspecified, **ask one sharp question** rather than guessing across
  a fork in the road. Guessing on protocol or rules is expensive to undo.

## TypeScript conventions

- Strict mode, `noUncheckedIndexedAccess`, ESM, Node 22+.
- No `any`. Use discriminated unions for actions/events and exhaustive `switch` with a
  `never` check in the default branch.
- Errors as values in the engine (`{ok: false, reason: 'BID_TOO_LOW'}`); exceptions only
  for genuine programmer bugs.
- Vitest for tests, fast-check for property tests.

## Swift conventions

- Swift 6, SwiftUI, strict concurrency. Minimum target iOS 17.
- `@Observable` view models; views stay dumb. `MatchViewModel` is per-screen;
  `GameSession` is the session-scoped one above it, owning the socket and the match
  lifecycle. A view with no state of its own (`OnboardingView`) gets no view model.
- Networking is a single `actor GameSocket` wrapping `URLSessionWebSocketTask`, exposing
  an `AsyncStream<ServerMessage>`. All socket access goes through it.
- Model types are `Codable` structs generated from the protocol — treat as read-only.
- Prefer value types. No force-unwrapping (`!`) outside tests.
- No third-party dependencies in v1 unless asked.

## Web client — the backlog

Ordered by how much each changes the experience, not by effort. Tier 1 (turn timer, paced
reveal, turn attention, phone layout) and Tier 2 (the hand tumbles in on a new round; the event
feed is grouped by round) are done and on `main`.

*(Cut from Tier 2: "make the standing bid more prominent". It has its own panel now — `on the
table 4 × ⚅` — and reads clearly on a real screen. Do not re-add it without new evidence.)*

**Tier 3 — rough edges**

- ~~**Rematch.**~~ Done on the web and the server. A party now outlives the match it starts, and
  `rematch` (protocol 4) asks to be put back in front of it; the host starts the next match from
  the same room code. See `docs/DECISIONS.md`. **iOS has none of this yet** — it is unaffected
  (it never sends `rematch`, and the gateway holds party updates back from anyone in a room), but
  an iOS player who sits on the end screen is still in the party and will be pulled into a
  rematch someone else starts. Giving iOS the button is the follow-up.
- ~~**Reconnect, tested in anger.**~~ Mostly done. Nine tests now drop a live match on a fake
  clock and drive the recovery, which found two real bugs: the backoff reset on `open` rather
  than on a working session, so a server that accepted and dropped (a `node --watch` restart, a
  rolling deploy) was dialled in a zero-delay loop; and a pending retry fired after `disconnect`,
  opening a socket nothing owned. **Still not done by hand** — nobody has turned wifi off for
  five seconds on a real phone, and a fake clock cannot tell you how it feels.
- ~~**The SPA fallback is too eager.**~~ Done. `static.ts` falls back to the page only for paths
  that read as navigations — not for `/assets/*`, and not for an extension `TYPES` serves.
- ~~**The shutdown logs four times.**~~ Done, though not as described: measured, it logged
  *once*. The line that appeared twice was node's own `.env not found`, because `node --watch`
  runs a supervisor and a child and both parsed `--env-file-if-exists`. `env.ts` now reads the
  file itself, and `shutdown` is guarded so repeated signals tear down once.

All four are done or part-done; what is left of each is written above. Before starting anything
new here, play a match first. This list was a guess at what is wrong, and a session spent
watching someone actually play beats it every time — Tier 1's turn timer was the only item on
the original list that turned out to be a functional gap rather than taste, and Tier 3's
shutdown item turned out not to be the bug it described.

## Testing bar before a phase is "done"

- Engine: every rule ID covered (`coverage.test.ts` enforces it); property tests assert
  invariants — total dice in play never increases (no v1 rule returns a die), a player's
  dice count stays in 0–5, state survives a JSON round trip, and the bid options handed to
  a client never depend on anybody's dice.
- Server: an integration test that drives 4 in-process clients through a full match to a
  winner, including a disconnect/resync.
- Web: two vitest projects. `test/*.test.ts` runs under plain **node** — the session is
  deliberately DOM-free, and keeping those tests there is what stops a DOM dependency creeping
  in. `test/dom/**` runs under **happy-dom** and mounts the real component tree in `StrictMode`,
  as `main.tsx` does, driven by a fake socket.

  happy-dom does no layout, so it cannot catch anything about *size or position*. It can resolve
  the cascade, which catches a rule that does nothing at all — the difference between a pip that
  is the wrong size and one that has no size. When you add a test there, break the thing on
  purpose and watch it fail: a fake socket that closed synchronously made the StrictMode test
  pass against the very bug it was written for.
- iOS: unit tests on the view models, the socket actor, and the session flow, all driven
  through `StubTransport` rather than a live server. `ProtocolDecodingTests` decodes a
  transcript captured from a real `Room` (`pnpm fixtures`), so the models are checked
  against what the server actually sends rather than hand-written JSON.

  There is **no XCUITest target** — nothing exercises the SwiftUI views themselves, so a
  view-layer bug (a wrong `ForEach` identity, a binding that never fires) is found by
  playing the game, not by CI. That is the accepted trade, not an oversight; say so
  plainly rather than implying the UI is covered.
