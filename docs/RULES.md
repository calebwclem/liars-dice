# Liar's Dice — Canonical Ruleset (v1)

This document is the **single source of truth** for game behavior. If code and this
document disagree, this document wins — fix the code. If this document is ambiguous,
stop and ask the human to amend it. Do not invent rules.

The variant below is **Pirate's Dice** — the common-hand form of liar's dice, as played
in Pirates of the Caribbean and described by the mainstream rule sources. It is *not*
Perudo/Dudo: the Peruvian palifico round is deliberately absent (R-13), as are the
ones-conversion bidding rules (R-09) and calza. Every rule has an ID so tests can
reference it (e.g. `test('R-07: a one counts as any face')`).

---

## Setup

- **R-01** 2–6 players per match. v1 matchmaking targets exactly **4**; the engine must
  support 2–6.
- **R-02** Each player starts with **5 dice**, six-sided, faces 1–6.
- **R-03** At the start of each round, every remaining player's dice are rolled secretly.
  A player sees only their own dice.

## Bidding

- **R-04** A bid is a pair `(quantity, face)` meaning: "across *all* dice still in play,
  at least `quantity` dice show `face`." `quantity` is an integer from 1 to the total
  number of dice still in play; a bid above that total is illegal.
- **R-05** Play proceeds clockwise (fixed seat order). The round's starting player makes
  the opening bid; there is no minimum opening bid other than R-06's validity rules.
- **R-06** On their turn a player must either **raise** or **challenge** (R-10). The very
  first player of a round must bid — they cannot challenge.
- **R-07** **Ones are wild**: a die showing 1 counts as any face. Always — there is no
  round or endgame in which this is suspended (R-13). The one exception is by face, not
  by round: a bid *on* ones counts only actual ones, never doubling a one that is already
  being counted as itself.

### Raising

- **R-08** A raise is legal if, compared to the current bid `(q, f)`, **at least one of
  quantity or face increases and neither decreases**:
  - same face, higher quantity: `(q+n, f)` for `n ≥ 1`; or
  - same quantity, higher face: `(q, f')` where `f' > f`; or
  - higher quantity, **any** face: `(q+n, f')` for `n ≥ 1` and any `f'`.

  So from `(3, 5)` the legal raises are `(3, 6)` and any `(q', f')` with `q' ≥ 4`.
  Lowering the quantity is never a raise.
- **R-09** **Ones have no special standing in bidding.** A bid on ones is raised, and
  raises over one, by R-08 alone: there is no halved quantity for switching to ones and
  no doubling for leaving them. `(4, 6)` is followed by `(5, anything)` and nothing
  cheaper; `(3, 1)` is followed by `(3, 2..6)` or `(4, anything)`.

  Note the consequence, which is deliberate. Ones are still wild when counting (R-07),
  but a bid *on* ones counts only ones — so at a given quantity a ones bid is half as
  likely to be true as any other face, and costs the same to make. Bidding ones is
  therefore a weak move, and the face is expected to fall out of use.

  When `(q, f)` is at the dice-in-play cap (R-04) with `f = 6`, no legal raise exists;
  the player must challenge.

## Challenging

- **R-10** **Dudo** (call liar) is the only challenge. All dice are revealed and counted
  against the standing bid.
  - If `actualCount >= quantity`, the bid was good → **the challenger loses one die**.
  - If `actualCount < quantity`, the bid was a lie → **the bidder loses one die**.

  Exactly one player loses exactly one die per round.
- **R-11** A player may never exceed 5 dice. (No v1 rule ever returns a die to a player,
  so this is an invariant the engine asserts rather than a branch it takes. It becomes
  load-bearing if calza — spot-on, which returns a die — is added in a later version.)
- **R-12** A player at 0 dice is **eliminated**. The last player with dice wins the match.

## The last die

- **R-13** **There is no palifico round.** A player down to one die plays by exactly the
  same rules as everyone else: ones stay wild for them and for the table, the face is
  never locked, and every face remains biddable at its usual quantity. Reaching one die
  changes nothing except how much you have left to lose.

  This is a deliberate divergence from Perudo, which suspends wild ones and locks the
  face for the round after a player drops to one die. Pirate's Dice has no such rule, and
  it works against the game: the short-stacked player is the one who most needs to bluff,
  and locking the face leaves them a single number to raise on. A lone wild one — the
  best hand a one-die player can hold — is worth the most precisely because it can be
  bid at any face, and palifico is the rule that takes that away.

  This rule is stated as an absence rather than deleted so the divergence is on the
  record and stays tested. See `docs/DECISIONS.md`.
- **R-14** If a player is eliminated, the next round starts with the player to their left
  (clockwise) who is still in the match.
- **R-15** Otherwise, the round after a challenge starts with the player who **lost the
  die**. If that player was eliminated, apply R-14.

## Timing and disconnection

- **R-16** Each turn has a **30-second** timer, enforced server-side.
- **R-17** On the first timeout in a match, the server plays the **minimum legal raise**
  for that player. On the second consecutive timeout, the player is flagged AFK and a
  **bot takes over their seat** for the rest of the match.
- **R-18** A disconnected player is given **45 seconds** to reconnect before bot takeover.
  On reconnect the client requests a full resync and resumes control.
- **R-19** If all human players disconnect, the match is abandoned and recorded as such.

## Fairness / randomness

- **R-20** All dice are rolled **server-side** using a CSPRNG. The server never sends a
  player another player's dice until a reveal (R-10) occurs.
- **R-21** (v1.1, not v1) Provable fairness: at round start the server publishes
  `SHA-256(seed || roundId)`; at reveal it publishes `seed` so clients can verify.

## Explicitly out of scope for v1

- Real-money or simulated wagering of any kind. No chips, no pots, no betting language.
  (This keeps the App Store age rating clean — see `docs/PLAN.md`.)
- House rules toggles, private lobbies, spectators, chat, tournaments.
