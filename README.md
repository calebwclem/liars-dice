# Liar's Dice

Real-time online multiplayer Liar's Dice. iOS first, then web, then Android.

## Start here

1. `CLAUDE.md` — architecture invariants, commands, and conventions. Read first.
2. `docs/RULES.md` — the canonical ruleset. The spec. Every rule has an ID.
3. `docs/PLAN.md` — stack rationale, infrastructure, and the phased roadmap.
4. `docs/KICKOFF_PROMPT.md` — the prompt to open Claude Code with, for Phases 0–1.
5. `docs/DECISIONS.md` — append-only architectural decision log.

## Status

**Phases 0 and 1 complete.** `packages/engine` implements the ruleset as a pure,
deterministic reducer with zero runtime dependencies. Rules R-01 to R-15 and R-20 are
covered by tests; R-16 to R-19 (turn timers, AFK takeover, reconnect grace, abandonment)
belong to Phase 2's server, and R-21 is v1.1 — see `docs/DECISIONS.md`.

Play a match in the terminal:

```bash
pnpm install
pnpm cli                      # you against three random-action bots
pnpm cli -- --seed 42         # reproduce a specific match
pnpm cli -- --players 6       # a six-handed table
pnpm cli -- --auto            # let a bot take your seat, to watch a match play out
```

Verify:

```bash
pnpm typecheck && pnpm lint && pnpm test
```

## Prerequisites

```bash
node -v          # 22+
pnpm -v          # 9+
brew install xcodegen    # needed from Phase 3
```
