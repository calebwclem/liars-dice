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

---

## 2026-09-16 — A themed table rather than a native-restrained one

**Decision:** Phase 4 takes the felt-and-leather direction: a lit green table, dice drawn with real
pips, a leather cup that lifts on the reveal, serif numerals, brass accents.

**Alternatives:** A restrained native look — system materials, SF Symbols, the platform type scale
— which would have been faster and would inherit dark mode, Dynamic Type and accessibility for
free.

**Why:** The owner chose it. What it costs is worth writing down, because none of it is optional:
every colour is defined twice (`Theme.adaptive`) since a bright felt green glows in the dark; the
dice are a `Shape` rather than the Unicode die glyphs, which are missing from the system font and
render as ▫ on device; and every animation is gated on `accessibilityReduceMotion`, because a table
of tumbling dice is exactly the interface where motion is both the point and the problem.

---

## 2026-09-16 — Haptics carry the feedback; audio is deferred

**Decision:** A full haptic vocabulary (`Haptics.Beat`) and no sound at all. Each beat of a round
has one feel and always the same one: a rigid tap per die as a hand lands, light on a bid, soft on
your turn, medium on a challenge, success/warning on the verdict, heavy on a lost die, error on an
elimination.

**Alternatives:** Synthesised placeholder tones; building the audio layer with the asset files left
missing.

**Why:** I cannot hear anything I produce, so shipping audio would mean shipping something nobody
had judged — and placeholder audio has a way of becoming permanent. Haptics can be reasoned about
precisely from the API. The call sites are in the view model rather than the views, behind an
injected closure, which is what lets `MatchFeelTests` assert the *order* a reveal is felt in.

A related rule falls out of R-18: a resync is silent. Catching up after a reconnect must not replay
every buzz the player missed, so only live updates are felt.

---

## 2026-09-16 — The reveal is a sequence, not a state

**Decision:** `MatchViewModel` owns a `RevealBeat` that advances cup → hands → counting → verdict →
outcome over roughly 2.5 seconds, inside the window the server holds the table for.

**Alternatives:** Showing the whole reveal at once, as Phase 3 did.

**Why:** R-10 is atomic on the server and has to be — but a person needs the moment spread out to
follow what happened to them, particularly *which* dice counted, since a wild one counting toward
another face is the single most confusing thing in the game for a new player. Pacing is injectable
(`RevealPacing.instant`) so tests assert the sequence without waiting for it.

---

## 2026-09-16 — turnStarted removed; the snapshot carries the turn length

**Decision:** The `turnStarted` server event, declared in Phase 2 and never emitted by anything, is
gone. `MatchSnapshot` gained `turnMs` instead.

**Alternatives:** Emitting `turnStarted` on every turn change.

**Why:** The countdown ring needs the whole as well as the remainder — a fraction cannot be drawn
without it — and that is the only thing the event carried that the snapshot did not already say.
Dead wire surface that no server emits is exactly the kind of thing that rots, and the snapshot is
already where the other server-owned annotations live.

---

## 2026-09-26 — Bots take a redacted view, and the type says so

**Decision:** `packages/bots` exposes `decide(view: PlayerView, { profile, rng })`. The server calls
`redactFor` before asking, so a bot receives exactly what a person would.

**Alternatives:** Passing `GameState` and trusting the policy not to look.

**Why:** The guarantee should be structural, not a comment. A policy that cannot be handed the table
cannot read it, however it is edited later — and it means the same code can back the web client's
offline practice mode in Phase 8 without a second implementation. It also keeps rules out: legality
comes from `legalBidsIn`, so a bot cannot propose a move the server would refuse.

---

## 2026-09-26 — One comparison, not two thresholds

**Decision:** On its turn a bot compares two numbers: the chance its best available raise is true,
against the chance the standing bid is false. Whichever is larger wins, scaled by an `aggression`
factor per profile.

**Alternatives:** Independent thresholds — raise if a bid clears some credibility bar, challenge if
the standing bid falls below another. That was the first implementation.

**Why:** Watching a match killed it. Two thresholds meant a bot opened with the boldest bid it could
still believe, which a cautious opponent called immediately, every round. There are only two legal
moves, so the question is never "is this bid good enough" in the abstract — it is which of the two
is better, and that is a comparison rather than a pair of tests.

Two more things only a played match revealed. The opening bid is now the *boldest* bid above a
confidence floor rather than the bid nearest a target: aiming at a target picks whichever bid sits
closest to it, and "one one" is about 60% likely on a full table — on target and worthless. And a
bluff takes the *likeliest* raise, not the cheapest: R-09 makes leaving a bid of ones cost 2q+1, so
the cheapest raise over "four ones" is nine of something, which everybody calls.

Measured over 600 four-player matches, one seat per profile plus a rotating fourth (fair share
33.3%): cautious 24.7%, balanced 46.7%, bold 28.7%, at 17.5 rounds per match with two thirds of
moves being bids. The profiles are personalities rather than difficulty tiers, so the spread is
acceptable; `tournament.test.ts` guards only against a profile becoming broken.

---

## 2026-09-26 — The terminal client moved to apps/cli

**Decision:** `packages/engine/src/cli.ts` became `apps/cli/src/main.ts`, its own workspace package
depending on the engine and the bots.

**Alternatives:** Keeping it in the engine with a dev dependency on `packages/bots`.

**Why:** The CLI now plays against real bots, which makes it a program with dependencies and a great
many side effects — and CLAUDE.md is unambiguous that the engine is a pure library with none. The
dev-dependency route would have kept the CI check passing while making the claim untrue. A side
benefit: with the CLI gone, the lint rules banning `Date` and `Math.random` inside the engine need
no exemption at all, and now cover the bots too.

---

## 2026-09-27 — R-09 removed: ones have no special standing in bidding

**Decision:** A raise is R-08 and nothing else — same quantity at a higher face, or a higher
quantity at any face. The conversions are gone: no `ceil(q/2)` to switch onto ones, no `2q+1` to
leave them. Face 1 is simply the lowest face. `docs/RULES.md` R-09 now says so.

**Alternatives:** Keeping the standard Perudo conversions and explaining them in the app; removing
the conversions *and* the wild ones, leaving six equal faces.

**Why:** The owner played a match and the conversions read as broken — "4 fours" followed by
"2 ones" looks like the quantity went backwards, because it did. The rule is real Perudo and the
engine implemented it correctly, but a rule that has to be explained before a player can tell
legal from broken is a cost, and this one was being paid every round.

The consequence was stated before the change and accepted: ones stay wild for *counting* (R-07),
but a bid on ones counts only ones, so at a given quantity it is half as likely as any other face
and now costs exactly as much. Bidding ones is therefore dominated. Measured over 400 bot matches
after the change, ones fell to **1.8% of all bids** — the face has effectively left the bidding.
That is the price of the simplicity, and it is the right way round to pay it: the game is easier to
learn and one option is dead, rather than harder to learn with every option alive.

Two things fell out of it. The bid comparator is now plain `[quantity, face]`, so `compareBids` no
longer needs to know whether ones are wild — the last place where the counting rule and the bidding
rule were entangled. And the only remaining dead end is the top of the ladder: `(cap, sixes)`, where
challenging is the only legal move.

**If this is ever revisited**, the honest middle option is the one not taken: keep the conversions
and make the app teach them at the moment they apply — the bid picker already knows the minimum for
every face and could say why it is what it is.

---

## 2026-09-27 — R-13 removed: the variant is Pirate's Dice, not Perudo

**Decision:** Palifico is gone. There is no round in which ones stop being wild and no round
in which the opening bid locks the face. A player down to one die plays by exactly the rules
everyone else is playing by. R-13 remains in `docs/RULES.md` as a stated absence rather than a
gap in the numbering, so the divergence stays on the record and stays tested.

**Alternatives:** Keeping palifico and explaining it better in the UI (a first attempt at this
shipped and was reverted the same day); keeping the ones-are-not-wild half and dropping only the
face lock; making it a per-match option.

**Why:** The owner played a match, hit a palifico round, and reported both halves as wrong — not
confusing, wrong. The face lock takes bluffing away from the player who most needs it: on one die
you have nothing to bid but a story, and a locked face leaves a single number to tell it with.
And a lone wild one is the best hand a one-die player can hold precisely because it argues for
every face equally; suspending wild ones deletes the one good outcome of the roll that put them
there. Both are true, and they compound: palifico fires exactly when a player is weakest and
removes the two tools that make being weak survivable.

The rule is Perudo's, not this game's. Pirate's Dice — the common-hand form, the one the owner
has played and the one the mainstream rule sources describe — has no palifico at all: ones are
wild throughout, a raise is quantity-up or face-up (R-08, already what we had), the challenge
loser starts the next round (R-15, already what we had), and reaching one die is just a dice
count. Removing palifico brought the ruleset *closer* to its sources rather than further away,
which is why this is a deletion and not an invention. `docs/RULES.md` now names the variant in
its header so the next question of this kind has a document to be settled against.

**What it cost.** More than the rule: palifico was the only thing in the game that varied by
round, so its removal took a whole axis out of the contract. `RoundState.palifico`,
`GameState.palificoNextFor`, `PlayerState.palificoUsed`, `PlayerView.round.lockedFace`,
`RevealSummary.wildOnes`, the `palificoArmed` event and the `PALIFICO_FACE_LOCKED` error are all
gone; `countFace` and `matchChance` lost their `wildOnes` parameter, because with no round able
to turn wildness off there is no caller left with a reason to ask. `BidContext` is down to
`{standing, diceInPlay}` — two public facts, which is a stronger statement of the redaction
property than the test that asserts it: the bid options handed to a client now *cannot* encode
anything about the cups, because there is nothing else in scope to encode.

This is a breaking wire change that removes fields rather than adding them, so
`PROTOCOL_VERSION` and `MIN_PROTOCOL_VERSION` both move to 2. Nothing is shipped, so the gate
simply refuses v1 rather than translating.

**Measured, 400 bot matches, same seeds before and after:**

| | with palifico | without |
|---|---|---|
| rounds per match | 17.5 | 17.1 |
| bids on ones | 1.8% | 0.1% |
| players reaching one die | 1299 | 1257 |
| mean further rounds survived on that die | 2.68 | 2.30 |
| ...who went on to win the match | 7.6% | 4.5% |

The last two rows run *against* the argument for the change and are recorded because of it: among
bots, the one-die player did measurably better under palifico, not worse. The mechanism is not
mysterious — with ones not wild, every bid in that round is far harder to satisfy, so challenges
land, and the player who gets caught is usually whoever raised rather than the short stack who
opened low. Palifico was, mechanically, a handicap round in favour of the player it fired for.

It was removed anyway, and the numbers do not argue otherwise. What the short stack lost was not
equity but *agency*: the choice of what to represent. A bot does not care that its options
collapsed to one face and a ladder, because it was never going to tell a story with them; a person
does, and the owner's complaint was exactly that. A rule that improves your odds by removing your
decisions is a worse rule than the one it replaced, and bot win rate is the wrong instrument for
seeing it. If the short stack later proves to need help, it should get a rule that gives it more
to do, not less.

The ones-bidding collapse is the other thing to note: 1.8% to 0.1%, effectively out of the game.
That was already the direction R-09's removal set (a bid on ones counts only ones, so it is half
as likely as any other face at the same price — dominated), and palifico was the last context
where bidding ones made sense, since ones were not wild there. The face is now wild for counting
and dead for bidding. Accepted, same trade as R-09: one dominated option in exchange for a rule a
new player can hold in their head.

**If this is ever revisited**, palifico belongs behind a match option decided at table creation
and shown in the lobby, not as a rule that fires without warning mid-match. That was the real
failure of the version that shipped: not that the rule was unexplained, but that a player learned
it existed at the moment it was used against them.

---

## 2026-09-28 — Pirate's Dice stays the default; palifico is parked as a variant

**Decision:** No rule change. The shipped ruleset remains the one agreed yesterday. Palifico is
neither restored nor discarded: it becomes a candidate named ruleset for custom games, sketched
under "Rule variants" in `docs/PLAN.md`. Nothing is built for it now.

**Alternatives:** Reverting to palifico on the strength of the measurement; building the variant
system immediately; making palifico a plain on/off toggle.

**Why:** The numbers in the previous entry cut against the change — the one-die player did better
under palifico — and the owner read them and chose to keep playing the way they play. That is the
right call on the evidence available: the measurement is of bots, and what the rule takes from a
*person* is the choice of what to represent, which no bot win rate can see. Keeping the default
and parking the alternative costs nothing today and keeps the question open.

Recording the shape now rather than later is the actual point of this entry. The removal commit
(`9c8195a`) is a complete, reviewed description of everything palifico touched, and `bbe6159` still
has the working code — so a Perudo set is a lift, not a rewrite, *while that is still true*. Six
months of drift from now it would be neither.

Two constraints are worth fixing before anyone implements it. Rulesets must be **named sets**, not
independent toggles: a bag of booleans multiplies the test matrix and invites combinations nobody
has played. And variants belong to **custom games only** — quick match stays single-ruleset, or the
queue splits and wait times double for a feature most players will never open.

---

## 2026-09-28 — Private games are a "party", separate from the queue

**Decision:** A private game is a **party**: players gathered behind a four-character code,
waiting for whoever created it to start. Four new client messages (`createParty`, `joinParty`,
`leaveParty`, `startParty`), two server messages (`partyState`, `partyLeft`), six error codes.
`PROTOCOL_VERSION` goes to 3; `MIN_PROTOCOL_VERSION` stays at 2, because the change is purely
additive and a v2 client simply has no button for it.

**Alternatives:** Extending the matchmaker with a keyed queue; a "private" flag on `findMatch`;
letting any player start rather than a host.

**Why a separate registry.** The matchmaker answers "find me anyone"; a party answers "hold a
seat for someone I know". They share only `startFrom`, and overloading the FIFO queue with keyed
buckets would have put two lifecycles in one class — one that backfills on a timer and one that
never starts until a person says so. `Parties` is its own file for the same reason `Room` is.

**Naming.** `Room` was already the live-match actor and the client already called its idle screen
the lobby, so a third thing called "room" would have made all three unreadable. Internally and on
the wire it is a **party**; the UI says "private game" and "room code", which is what players
actually say. Three names for three things: a party waits behind a code, the queue waits for the
matchmaker, a room is a match in progress.

**The code.** Four characters from a 32-letter alphabet with no confusable glyphs — no O or 0, no
I or 1 — because the code's whole job is to survive being read aloud. That is ~1.05M codes for
something that lives only as long as the party, and the generator retries on collision rather
than assuming it away. Codes come from the system CSPRNG, not `Math.random()`: a code is not a
secret, but it is the only thing between a private game and a stranger.

Strictness sits on the wire and leniency sits in the text field, which is the right way round.
The schema accepts uppercase only; the client uppercases, drops anything outside the alphabet,
and truncates as you type. A player who types lowercase should never see "bad message".

**Two deliberate behaviours.**

*The host is transferable.* When the host leaves — and a dropped connection is how most hosts
will leave — the party passes to whoever has been there longest rather than dissolving. The code
keeps working, so a host whose wifi blipped walks straight back in.

*Disconnecting leaves the party, unlike a match.* R-18 holds a seat in a live match for 45
seconds because a seat carries dice. A party seat carries nothing, so a drop just removes you and
the others are told; rejoining costs one code. Worth revisiting if playtests show people losing
their party to a lift ride.

**Bots are opt-in per match, not automatic.** The public queue backfills on a timer because
nobody wants to wait for strangers. A party already knows who it is waiting for, so the host gets
a toggle instead: two friends who want a head-to-head get exactly that (R-01 allows 2), and three
who want a full table get one bot. Defaulting the toggle *on* matches what most private games
will want.

**What this does not include:** rule variants per party (parked, see PLAN.md), kicking, rejoining
a party in progress, or join links. The code plus a group chat covers the playtest case, and
every one of those is cheaper to add once people have actually used this.
