# Kickoff prompt for Claude Code

## Before you paste anything

```bash
mkdir liars-dice && cd liars-dice && git init
# copy CLAUDE.md to ./CLAUDE.md
# copy RULES.md and PLAN.md to ./docs/
git add -A && git commit -m "docs: project spec and conventions"
brew install xcodegen          # needed from Phase 3 onward
claude
```

Then read `docs/RULES.md` yourself, start to finish. It is the one document where an
error costs you the most, and it's the one place Claude Code cannot check your intent.

---

## Prompt 1 — Phases 0 and 1 (paste this)

> Read `CLAUDE.md` and `docs/RULES.md` in full before writing any code. `docs/RULES.md`
> is the canonical spec; every rule has an ID.
>
> Your task is **Phase 0 and Phase 1 only**. Do not build the server, the iOS client,
> networking, or persistence. Do not create placeholder directories for them.
>
> **Phase 0 — foundation:**
> - pnpm workspace monorepo, Node 22, ESM, TypeScript strict (including
>   `noUncheckedIndexedAccess`), Vitest, ESLint + Prettier.
> - Create only `packages/engine` for now.
> - A GitHub Actions workflow running typecheck, lint, and tests.
>
> **Phase 1 — the rules engine.** `packages/engine` exports a pure, deterministic
> reducer with zero runtime dependencies and zero I/O:
>
> ```ts
> reduce(state: GameState, action: Action, ctx: Ctx): Result<{state: GameState, events: GameEvent[]}>
> ```
>
> where `Ctx` injects `now: number` and `rng: () => number`. Actions and events are
> discriminated unions. Illegal actions return an error value (never throw), with a
> machine-readable reason code.
>
> `GameState` must hold full information (all players' dice). Also export
> `redactFor(state, playerId): PlayerView` which strips every other player's dice —
> this is the only function that will ever be allowed to produce client-facing state.
>
> **Work rule-by-rule, test-first.** For each rule ID in `docs/RULES.md`, write a failing
> test whose name begins with the rule ID, then implement it. Cover R-01 through R-21
> except R-21 (defer). Pay particular attention to R-08 and R-09 (raise legality,
> including the ones/non-ones conversions) and R-13 through R-15 (palifico and round
> starter selection) — these are the rules most likely to be wrong.
>
> Add property-based tests with fast-check asserting invariants across random legal
> action sequences:
> - total dice in play never increases except via a successful calza
> - every player's dice count stays within 0–5
> - a match always terminates with exactly one winner
> - `JSON.parse(JSON.stringify(state))` round-trips identically
> - replaying the same action list with the same seed yields the identical final state
>
> Finally, add `packages/engine/src/cli.ts` wired to a root `pnpm cli` script: a terminal
> client that lets a human play a full 4-player match against random-action bots, showing
> the human's own dice, the bid history, and the reveal at each challenge.
>
> **Done means:** `pnpm typecheck && pnpm lint && pnpm test` all pass, every rule ID
> appears in at least one test name, and `pnpm cli` plays a complete match to a winner.
>
> Start by proposing your `GameState`, `Action`, and `GameEvent` type definitions and
> waiting for my approval before implementing. If anything in `docs/RULES.md` is
> ambiguous, ask now rather than guessing.

---

## Why it's scoped this way

The prompt does four things that the "build me a multiplayer dice game" version doesn't:

1. **One phase only.** The failure mode of agentic coding on a greenfield project is
   breadth — five subsystems at 40% each, none testable. Depth-first fixes it.
2. **Points at a spec.** The rules are settled in a document you reviewed, so the agent
   isn't inventing a variant halfway through.
3. **Defines "done" mechanically.** A command that either passes or doesn't, not a vibe.
4. **Forces a design checkpoint.** Approving the type definitions takes you five minutes
   and is the cheapest possible place to catch a wrong model.

## Prompts for later phases (sketch)

**Phase 2:** "Read `CLAUDE.md`, `docs/RULES.md`, and `packages/engine`. Build
`packages/protocol` (Zod schemas, `PROTOCOL_VERSION = 1`) and `apps/server`. The engine
is already correct — do not reimplement or modify rules logic. Done when
`pnpm test:integration` drives four in-process clients through a full match including one
disconnect and resync, and a test asserts no outbound message ever contains another
player's dice."

**Phase 3:** "Set up `clients/ios` with XcodeGen (`project.yml`, iOS 17, Swift 6 strict
concurrency). Build the model codegen in `tools/codegen` first. Then: guest auth, a
`GameSocket` actor, and one playable screen. Deliberately unstyled — correctness only.
After every file addition run `xcodegen generate`, then verify with `xcodebuild ... build`
and `xcodebuild ... test`. Never edit the .xcodeproj."

Keep that pattern: name the phase, name what already exists and is off-limits, state the
verification command.
