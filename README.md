# Liar's Dice

Real-time online multiplayer Liar's Dice. iOS first, then web, then Android.

## Start here

1. `CLAUDE.md` — architecture invariants, commands, and conventions. Read first.
2. `docs/RULES.md` — the canonical ruleset. The spec. Every rule has an ID.
3. `docs/PLAN.md` — stack rationale, infrastructure, and the phased roadmap.
4. `docs/KICKOFF_PROMPT.md` — the prompt to open Claude Code with, for Phases 0–1.
5. `docs/DECISIONS.md` — append-only architectural decision log.

## Status

**Phases 0, 1 and 2 complete.** Every rule in `docs/RULES.md` is implemented and tested
except R-21, which the document itself marks v1.1.

| Package | What it is |
|---|---|
| `packages/engine` | The rules (R-01..R-15, R-20) as a pure deterministic reducer. Zero runtime dependencies. |
| `packages/protocol` | Zod schemas for every message. `PROTOCOL_VERSION = 1`. The source `tools/codegen` will read. |
| `apps/server` | WebSocket gateway, guest auth, matchmaker, room actors. Owns the clock and the sockets, so it owns R-16..R-19. |

Play a match in the terminal, no server needed:

```bash
pnpm install
pnpm cli                      # you against three random-action bots
pnpm cli -- --seed 42         # reproduce a specific match
pnpm cli -- --players 6       # a six-handed table
pnpm cli -- --auto            # let a bot take your seat, to watch a match play out
```

Run the server:

```bash
cp apps/server/.env.example apps/server/.env    # AUTH_SECRET is generated in dev if unset
pnpm dev:server                                 # ws://localhost:8080, GET /health
```

Verify:

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
