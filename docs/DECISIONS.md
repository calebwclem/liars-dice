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

---

## 2026-09-14 — R-16 to R-19 live in the server, not the engine

**Decision:** The turn timer, the timeout auto-bid, AFK takeover, the reconnect grace period
and abandonment are implemented in `apps/server/src/room.ts`. The engine stays silent on
clocks and sockets; it gained nothing for Phase 2 except a way to answer "is this bid legal"
from a `PlayerView`.

**Alternatives:** Modelling them in the engine as system actions (`timeout`, `disconnect`,
`reconnect`, `botTakeover`) with deadlines computed from `ctx.now` — the shape proposed and
rejected during the Phase 1 design review.

**Why:** These four rules are about connection state, which is the server's subject. Keeping
them out of the engine leaves `packages/engine` a pure function of the *rules* — the thing
the web client will one day run offline, where no socket exists. The cost is that R-16..R-19
are tested against a fake clock in `apps/server` rather than as reducer cases, which is why
`Clock` is injected everywhere: a 45-second rule has to be testable in a millisecond.

---

## 2026-09-14 — One message carries both the events and the resulting snapshot

**Decision:** Every state change sends one `state` message per player containing the events
of the transition *and* that player's full redacted snapshot. `resume` answers with the same
shape, marked `sync`, plus whatever events are still in the room's history buffer.

**Alternatives:** Events only, with clients folding them into local state (smaller messages,
and the usual source of desync bugs); snapshots only (no way to animate what changed).

**Why:** A client never has to derive truth from an event stream — the snapshot is always
authoritative and the events exist purely so the UI can animate what just happened. That
makes reconnection trivial: the answer to "what did I miss" is the same message shape as
"here is what happened", and a client that ignores the event list is still correct, just less
pretty. At six players a snapshot is a few hundred bytes and there is roughly one per turn.

---

## 2026-09-14 — In-memory matchmaking and stateless guest tokens; no Redis, no Postgres

**Decision:** The queue, the room registry and presence are process memory. Guest identity is
a `playerId.expiry.hmac` token signed with `AUTH_SECRET`, so the server can recognise a
returning player without storing anything.

**Alternatives:** Redis for the queue and presence now, per the PLAN.md diagram.

**Why:** Phase 2's queue is a list of at most a few player ids, and its done-criterion is an
in-process integration test. Redis earns its place when there is a second machine and a
socket has to be routed to the room that holds it — `fly-replay` and a room→machine map —
which is a different problem than the one being solved here. Stateless tokens mean Phase 2
needs no database at all; Phase 6 adds Postgres when there are accounts worth persisting.
There is no revocation and no refresh, which is the honest cost of having no store.

---

## 2026-09-14 — A CSPRNG for dice costs exact replay, and that is the right trade

**Decision:** The server passes `crypto.randomBytes`-backed randomness to the engine (R-20).
The room keeps its action list in memory, but an action list alone no longer reproduces a
match.

**Alternatives:** Seeding a PRNG per match from a CSPRNG value and storing the seed — which
would keep replay exact *and* set up R-21's fairness commitment.

**Why:** R-20 says dice are rolled with a CSPRNG, and the literal reading is the safe one
while nothing depends on replay yet. The seeded-per-match alternative is genuinely
attractive and is what R-21 will need in v1.1; revisit it then, together with publishing
`SHA-256(seed || roundId)` at round start. Until then, replaying a match means recording the
rolls, which the reveal events already contain.

---

## 2026-09-14 — Two auto-play policies, both placeholders

**Decision:** `timeoutAction` plays R-17's minimum legal raise, exactly as the rule states.
`botAction` — what a seat plays once a bot holds it for good — picks a random legal action
with a fixed challenge rate. Both live in `apps/server/src/autoplay.ts` and read only the bid
context, never anyone's dice.

**Alternatives:** One policy for both, always the minimum legal raise.

**Why:** A seat that always plays the minimum raise walks every round up the entire bid
ladder, which is legal but makes the match interminable for the humans still at the table.
R-17's wording is specific about the *timeout* case, so that one is literal; the takeover case
has no wording to obey. `packages/bots` (Phase 5) replaces both with binomial expectation over
the unseen dice, and will take a redacted view — which is why neither of these looks at a
hand today.

---

## 2026-09-14 — Codegen goes Zod → JSON Schema → Swift

**Decision:** `tools/codegen` converts the protocol schemas with zod 4's `z.toJSONSchema`,
normalises that into a small IR, and emits Swift from the IR. Discriminated unions become Swift
enums with associated values; `Face` becomes an `Int`-backed enum; records become dictionaries.

**Alternatives:** Walking zod's internal `_zod.def` tree (more precise, but private API that
breaks on a minor upgrade); hand-writing the Swift models (forbidden by CLAUDE.md, and the thing
most likely to drift).

**Why:** JSON Schema is a public, documented output of zod and a stable intermediate, and the IR
means the Swift emitter never has to know that `anyOf: [X, {type: 'null'}]` spells nullable.
Phase 9's Kotlin emitter starts from the same IR rather than reinterpreting JSON Schema again.

Two things the emitter has to get right that the compiler cannot guess. Nullable and optional
both become `T?` in Swift but encode differently — an explicit `null` versus an absent key — and
the server's schemas are strict, so conflating them produces rejected messages. And a nested
payload struct must not shadow a top-level type: `ClientMessage.bid` generated a nested `Bid`
whose own `bid: Bid` field resolved to itself, an infinitely sized type. Payload names that
collide with a declared or standard-library type now gain a `Payload` suffix.

---

## 2026-09-14 — The server sends the legal bid set, so the client can grey out a button without knowing a rule

**Decision:** `MatchSnapshot.bidOptions` carries, for the player on turn, the cheapest legal
quantity per face plus R-04's cap. The engine computes it (`bidOptionsIn`); the client reads it.

**Alternatives:** Reimplementing bid legality in Swift (forbidden: CLAUDE.md puts zero rules in
the client); sending the whole legal set, up to 180 bids; sending nothing and letting every
illegal tap cost a round trip.

**Why:** Phase 2 gave the *TypeScript* engine a way to answer "is this legal" from a `PlayerView`,
which a Swift client cannot call — a gap that only became visible when the client was built. For
a fixed face the legal quantities are one contiguous run up to the cap, so six numbers describe
the entire legal set exactly. That is a consequence of the bid comparator rather than anything
stated in docs/RULES.md, so a property test pins it: if it ever stopped being true the client's
bid picker would start offering illegal bids, and the test fails instead.

---

## 2026-09-14 — The iOS tests decode a captured server transcript

**Decision:** `pnpm fixtures` drives a real `Room` through a whole match and writes every message
one player received to `clients/ios/Tests/Fixtures/transcript.json`, which is committed. The Swift
tests decode it, and the scripted-match test replays it through a stubbed socket.

**Alternatives:** Hand-written Swift fixtures; standing up the Node server from the iOS test
suite.

**Why:** A hand-written fixture only proves the generated models agree with whoever wrote it. This
proves they agree with what the server actually emits, including the R-18 connection events. The
transcript going stale is itself caught: CI regenerates it and fails on a diff.

---

## 2026-09-14 — One app target, no extra module

**Decision:** `clients/ios` is a single XcodeGen app target plus a unit-test target, exactly as
CLAUDE.md describes.

**Alternatives:** A local SwiftPM package for models, networking and view models, with the app as
a thin shell.

**Why:** The package split was motivated by a machine without Xcode, where `swift test` is the
only way to run anything — XCTest needs Xcode. With Xcode present the motivation disappears, and
DECISIONS.md already names Tuist as the upgrade path if this genuinely grows to several modules.
One target keeps the project file trivial and leaves Phase 4 free to use iOS-only APIs without a
platform guard.
