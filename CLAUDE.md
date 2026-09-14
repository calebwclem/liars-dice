# CLAUDE.md

Project: **Liar's Dice** — a real-time, online multiplayer dice game.
Ship order: iOS first, then web, then Android. One shared rules engine, thin clients.

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
apps/web/             (Phase 8) React + Vite client.
clients/ios/          SwiftUI app. project.yml (XcodeGen) — see below.
clients/android/      (Phase 9) Kotlin + Compose.
tools/codegen/        protocol -> Swift/Kotlin model generation.
docs/RULES.md         CANONICAL RULESET. The spec. Read it before touching the engine.
docs/PLAN.md          Phased roadmap and infrastructure.
docs/DECISIONS.md     Append-only log of architectural decisions.
```

## Commands

```bash
pnpm install                 # from repo root
pnpm test                    # all TS tests
pnpm --filter engine test    # engine tests only (fast — use this while iterating)
pnpm --filter engine test:prop  # property-based invariant tests
pnpm dev:server              # local server on :8080
pnpm cli                     # terminal client — play a full game against bots, no UI
pnpm codegen                 # regenerate Swift/Kotlin models from packages/protocol
pnpm lint && pnpm typecheck  # must both pass before you say a task is done
```

iOS (run from `clients/ios/`):

```bash
xcodegen generate            # ALWAYS after adding/removing/renaming a Swift file
xcodebuild -scheme LiarsDice -destination 'platform=iOS Simulator,name=iPhone 16' build
xcodebuild -scheme LiarsDice -destination 'platform=iOS Simulator,name=iPhone 16' test
```

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
- No secrets in the repo. Server config comes from env vars; see `.env.example`.

## Workflow expectations

- **Test-first for the engine.** Write the failing test citing the rule ID from
  `docs/RULES.md` (e.g. `R-09`), then implement. Every rule ID must appear in at least
  one test name.
- **Work in vertical slices.** Finish one slice end-to-end before starting the next.
  Do not scaffold five half-built subsystems.
- **Run the tests before claiming anything works.** If you cannot run it, say so
  explicitly rather than asserting success.
- **Small commits**, conventional-commit messages (`feat(engine): palifico rounds`).
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
- `@Observable` view models; views stay dumb. One view model per screen.
- Networking is a single `actor GameSocket` wrapping `URLSessionWebSocketTask`, exposing
  an `AsyncStream<ServerMessage>`. All socket access goes through it.
- Model types are `Codable` structs generated from the protocol — treat as read-only.
- Prefer value types. No force-unwrapping (`!`) outside tests.
- No third-party dependencies in v1 unless asked.

## Testing bar before a phase is "done"

- Engine: every rule ID covered; property tests assert invariants (total dice never
  increase except via R-10 calza; a player's dice count is 0–5; state is serializable
  round-trip).
- Server: an integration test that drives 4 in-process clients through a full match to a
  winner, including a disconnect/resync.
- iOS: unit tests on view models and the socket actor; at least one UI smoke test that
  plays a scripted match against a stubbed server.
