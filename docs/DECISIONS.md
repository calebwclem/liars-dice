# Architectural Decision Log

Append-only. Newest entries at the bottom. Keep each entry short: what was decided,
what else was considered, and why this won.

---

## 2026-09-12 — Server-authoritative with a pure shared engine

**Decision:** All rules and randomness live in `packages/engine`, a pure deterministic
reducer executed only on the server. Clients send intents and render redacted snapshots.

**Alternatives:** Client-side rules with server validation (rejected: duplicated logic
across three platforms, and hidden information makes client authority unsafe); a
lockstep peer-to-peer model (rejected: no trusted dice roller, NAT traversal pain).

**Why:** Hidden information means the client fundamentally cannot be trusted with dice.
Making the engine pure also makes it exhaustively testable and lets the same code back
the future web client's offline practice mode.

---

## 2026-09-12 — Native clients rather than a cross-platform framework

**Decision:** SwiftUI for iOS now; React and Compose later. No React Native / Flutter /
Unity.

**Alternatives:** React Native or Flutter for one UI codebase across all three targets.

**Why:** Owner wants to learn Swift and iOS properly. Because the clients are thin, the
duplicated surface is only the UI layer, and it isn't paid for until Phases 8 and 9.
Revisit if maintaining three UIs becomes the bottleneck — the server would not change.

---

## 2026-09-12 — Plain WebSockets over a game-server framework

**Decision:** `ws` on Node with a hand-rolled versioned JSON protocol validated by Zod.

**Alternatives:** Colyseus, Nakama, Photon.

**Why:** Liar's Dice is turn-based at roughly one message per turn. Those frameworks
exist to solve tick loops and continuous state synchronization, neither of which applies.
Fewer dependencies, full control over the protocol, and no framework-shaped constraints
on the room model.

---

## 2026-09-12 — XcodeGen for the iOS project file

**Decision:** `clients/ios/project.yml` is the source of truth; `.xcodeproj` is generated
and gitignored.

**Alternatives:** Checking in `.xcodeproj`; Tuist.

**Why:** `project.pbxproj` is a generated blob that both humans and coding agents corrupt
when adding files, and merge conflicts in it are miserable. Tuist is the upgrade path if
the project grows to multiple modules or targets.

---

## 2026-09-13 — Ruleset amendments settled before the engine was written

**Decision:** Four changes to `docs/RULES.md`, agreed with the owner during the Phase 1
design review:

1. **R-08 widened.** A raise is legal when at least one of quantity/face increases and
   neither decreases. The original two bullets accidentally forbade raising the quantity
   while lowering the face (`(3,5) → (4,2)`), which is legal in every Perudo table the
   owner has played at.
2. **R-04 gained a quantity cap.** `quantity` may not exceed the total dice in play.
3. **Calza (spot-on) cut from v1.** R-10 is dudo-only; R-06's "or spot-on" clause and
   R-13's "calza is disabled" bullet are gone, and R-11's 5-dice ceiling is now an
   asserted invariant rather than a branch.
4. **R-09 clarified** to state that the cap can leave a conversion with no legal
   quantity, in which case the player must raise another way or challenge.

**Alternatives:** Keeping R-08 literally (a legitimate but non-standard variant that
makes faces monotonically non-decreasing within a round); no quantity cap (standard
Perudo, where a provably-false bid is legal and simply gets dudo'd); keeping calza.

**Why:** R-08 was a wording bug, not a variant choice. The cap makes the bid ladder a
strictly ascending walk through a finite set, so every round provably terminates and the
reducer has no unbounded action space — the one dead end, a maximal ones bid, correctly
forces a dudo. Calza was the most complex rule in the document, the owner had never
played with it, and it was the *only* way dice re-enter the game; cutting it means "total
dice in play never increases" is an unconditional invariant. Re-adding it later is one
action and one reducer branch.

---

## 2026-09-13 — Timing and disconnection rules (R-16..R-19) deferred to Phase 2

**Decision:** Phase 1's engine covers R-01..R-15 and R-20 and is silent on turn timers,
AFK takeover, reconnect grace, and abandonment. It exports `minimumLegalBid` so the
server's R-17 auto-bid has a rules-owned answer to call.

**Alternatives:** Modelling the policy in the engine now via `timeout` / `disconnect` /
`reconnect` / `botTakeover` system actions, with deadlines computed from `ctx.now`.

**Why:** Those four rules are about connection state, which is Phase 2's subject. Pulling
them forward would have added five fields to `PlayerState` and four actions with nothing
to exercise them. The rule IDs are carried as `test.todo` stubs so the coverage table
stays honest about what is and is not implemented.

---

## 2026-09-13 — A challenge does not roll the next round in the same reduce call

**Decision:** Resolving a dudo moves the match to `phase: {kind:'reveal'}` and records a
`RevealSummary` in `state.lastReveal`. A separate `advanceRound` action applies
R-13/R-14/R-15 and re-rolls (R-03). `advanceRound` is server-issued and never accepted
from a client.

**Alternatives:** One atomic reduce that reveals and re-rolls together, with clients
reconstructing the reveal from the returned event list.

**Why:** A client that reconnects between the reveal and the next roll must be able to see
the reveal in its snapshot rather than an already-restarted round — the event list has
gone by then. The engine deliberately does *not* carry a reveal duration; pacing is the
server's business, not a rule in `docs/RULES.md`.

---

## 2026-09-13 — Events are public; private state reaches a player only via redactFor

**Decision:** Every `GameEvent` is safe to broadcast verbatim to every player. No event
carries a die face except `diceRevealed`, which is emitted only after R-10 has fired. A
player learns their own hand exclusively from `redactFor(state, playerId).you.dice`.

**Alternatives:** Per-recipient event streams with hands attached to a `diceRolled` event.

**Why:** It collapses the redaction problem to a single function plus a single invariant
that a test can state directly, instead of a per-event audit. `roundStarted` therefore
carries dice *counts* only, and there is no `diceRolled` event at all.
