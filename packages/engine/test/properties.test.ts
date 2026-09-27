import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import {
  bidOptionsOf,
  checkBid,
  compareBids,
  createMatch,
  legalBids,
  reduce,
  totalDiceInPlay,
} from '../src/index.ts';
import type { Action, Bid, Face, GameState } from '../src/types.ts';
import { bid, ctx, makeState, playRandomMatch, replayActions, unwrap } from './helpers.ts';

const ID_POOL = ['a', 'b', 'c', 'd', 'e', 'f'] as const;
const seeds = fc.integer({ min: 0, max: 2 ** 31 - 1 });
const playerCounts = fc.integer({ min: 2, max: 6 });
const ids = (n: number): readonly string[] => ID_POOL.slice(0, n);
const RUNS = { numRuns: 150 } as const;

describe('Invariants across random legal play', () => {
  test('R-10/R-11: total dice in play never increases', () => {
    fc.assert(
      fc.property(seeds, playerCounts, (seed, n) => {
        const { states } = playRandomMatch({ seed, playerIds: ids(n) });
        let previous = totalDiceInPlay(states[0]!);
        for (const state of states) {
          const total = totalDiceInPlay(state);
          expect(total).toBeLessThanOrEqual(previous);
          previous = total;
        }
        // No v1 rule returns a die, so at the end the only dice left are the winner's —
        // somewhere between 1 and 5 of them, never more than they started with.
        const { final } = { final: states[states.length - 1]! };
        const winner = final.players.filter((p) => p.diceCount > 0);
        expect(winner).toHaveLength(1);
        expect(previous).toBe(winner[0]!.diceCount);
        expect(previous).toBeGreaterThanOrEqual(1);
        expect(previous).toBeLessThanOrEqual(final.config.maxDice);
      }),
      RUNS,
    );
  });

  test('R-02/R-11/R-12: every dice count stays within 0..5', () => {
    fc.assert(
      fc.property(seeds, playerCounts, (seed, n) => {
        const { states } = playRandomMatch({ seed, playerIds: ids(n) });
        for (const state of states) {
          for (const player of state.players) {
            expect(player.diceCount).toBeGreaterThanOrEqual(0);
            expect(player.diceCount).toBeLessThanOrEqual(state.config.maxDice);
            // A hand is dealt per die owned (R-03), never more.
            expect((state.round.hands[player.id] ?? []).length).toBeLessThanOrEqual(
              state.config.maxDice,
            );
          }
        }
      }),
      RUNS,
    );
  });

  test('R-12: a match always terminates with exactly one winner', () => {
    fc.assert(
      fc.property(seeds, playerCounts, (seed, n) => {
        const { final, steps } = playRandomMatch({ seed, playerIds: ids(n) });
        expect(final.phase.kind).toBe('ended');
        // Terminated well inside the cap, so this is a real result and not a timeout.
        expect(steps).toBeLessThan(20_000);
        const standing = final.players.filter((p) => p.diceCount > 0);
        expect(standing).toHaveLength(1);
        expect(final.phase.kind === 'ended' && final.phase.winnerId).toBe(standing[0]!.id);
        expect(final.endedAt).not.toBeNull();
      }),
      RUNS,
    );
  });

  test('R-20: state survives a JSON round trip unchanged', () => {
    fc.assert(
      fc.property(seeds, playerCounts, (seed, n) => {
        const { states } = playRandomMatch({ seed, playerIds: ids(n) });
        for (const state of states) {
          const clone: unknown = JSON.parse(JSON.stringify(state));
          expect(clone).toEqual(state);
          // toEqual is blind to a key whose value is undefined; serialising twice is not.
          expect(JSON.stringify(clone)).toBe(JSON.stringify(state));
        }
      }),
      RUNS,
    );
  });

  test('R-20: replaying an action list with the same seed reproduces the final state', () => {
    fc.assert(
      fc.property(seeds, playerCounts, (seed, n) => {
        const { final, actions } = playRandomMatch({ seed, playerIds: ids(n) });
        expect(replayActions(seed, ids(n), actions)).toEqual(final);
        // A different seed must not land in the same place, or the rng is not being used.
        const other = replayActions(seed + 1, ids(n), actions.slice(0, 1));
        expect(other.round.hands).not.toEqual(final.round.hands);
      }),
      RUNS,
    );
  });

  test('R-20: a resumed state continues identically — no hidden state outside GameState', () => {
    fc.assert(
      fc.property(seeds, playerCounts, (seed, n) => {
        const { states, actions } = playRandomMatch({ seed, playerIds: ids(n) });
        // Pick up a mid-match state, serialise it as the server would for a resync, and
        // apply the next action to both copies. They must agree.
        const at = Math.min(states.length - 2, Math.floor(states.length / 2));
        const live = states[at]!;
        const resumed = JSON.parse(JSON.stringify(live)) as GameState;
        const action = actions[at]!;
        const fromLive = unwrap(reduce(live, action, { now: 1, rng: () => 0.5 }));
        const fromResumed = unwrap(reduce(resumed, action, { now: 1, rng: () => 0.5 }));
        expect(fromResumed.state).toEqual(fromLive.state);
        expect(fromResumed.events).toEqual(fromLive.events);
      }),
      RUNS,
    );
  });

  test('R-04..R-15: an illegal action is always a value, never a throw', () => {
    const anyBid = fc.record({
      quantity: fc.integer({ min: -3, max: 40 }),
      face: fc.integer({ min: -1, max: 9 }) as fc.Arbitrary<Face>,
    });
    const anyAction: fc.Arbitrary<Action> = fc.oneof(
      fc.record({
        type: fc.constant('bid' as const),
        playerId: fc.constantFrom(...ID_POOL, 'ghost'),
        bid: anyBid,
      }),
      fc.record({
        type: fc.constant('dudo' as const),
        playerId: fc.constantFrom(...ID_POOL, 'ghost'),
      }),
      fc.constant({ type: 'advanceRound' as const }),
    );

    fc.assert(
      fc.property(
        seeds,
        playerCounts,
        fc.array(anyAction, { maxLength: 60 }),
        (seed, n, actions) => {
          let state = unwrap(createMatch({ matchId: 'M', playerIds: ids(n) }, ctx(seed))).state;
          for (const action of actions) {
            const result = reduce(state, action, ctx(seed));
            if (result.ok) {
              expect(result.value.state.seq).toBe(state.seq + 1);
              state = result.value.state;
            } else {
              expect(typeof result.reason).toBe('string');
            }
          }
        },
      ),
      RUNS,
    );
  });
});

describe('R-08/R-09 checked against the arithmetic in the document', () => {
  /** Six players, five dice each: a 30-die table, so no minimum is clipped by R-04. */
  const table = (standing: Bid, palifico = false): GameState =>
    makeState({
      hands: Object.fromEntries(ID_POOL.map((id) => [id, [1, 2, 3, 4, 5] as Face[]])),
      bids: [{ playerId: 'a', bid: standing }],
      turnId: 'b',
      palifico,
    });

  /** The smallest quantity at which `face` becomes a legal raise over `standing`. */
  const minQuantityFor = (standing: Bid, face: Face, palifico = false): number | null => {
    const state = table(standing, palifico);
    for (let q = 1; q <= totalDiceInPlay(state); q += 1) {
      if (checkBid(state, { quantity: q, face }).ok) return q;
    }
    return null;
  };

  const quantities = fc.integer({ min: 1, max: 14 });
  const nonOneFaces = fc.constantFrom<Face>(2, 3, 4, 5, 6);

  test('R-09: reaching ones costs one more die, like every other face below', () => {
    // No halved quantity. Ones are the lowest face, so from any other face they need q+1 —
    // the same as any face at or below the standing one.
    fc.assert(
      fc.property(quantities, nonOneFaces, (q, f) => {
        expect(minQuantityFor(bid(q, f), 1)).toBe(q + 1);
      }),
    );
  });

  test('R-09: leaving ones costs nothing extra — a higher face at the same quantity does it', () => {
    // No doubling. Every face above ones clears a ones bid at the same quantity.
    fc.assert(
      fc.property(quantities, nonOneFaces, (q, f) => {
        expect(minQuantityFor(bid(q, 1), f)).toBe(q);
      }),
    );
  });

  test('R-08: ones over ones needs exactly one more die', () => {
    fc.assert(
      fc.property(quantities, (q) => {
        expect(minQuantityFor(bid(q, 1), 1)).toBe(q + 1);
      }),
    );
  });

  test('R-08: a higher face is free at the same quantity; the same face costs one more', () => {
    fc.assert(
      fc.property(quantities, nonOneFaces, nonOneFaces, (q, f, f2) => {
        const expected = f2 > f ? q : q + 1;
        expect(minQuantityFor(bid(q, f), f2)).toBe(expected);
      }),
    );
  });

  test('R-08: bid strength is a total order — exactly one of a<b, b<a, a=b holds', () => {
    const anyBid = fc.record({
      quantity: fc.integer({ min: 1, max: 30 }),
      face: fc.constantFrom<Face>(1, 2, 3, 4, 5, 6),
    });
    fc.assert(
      fc.property(anyBid, anyBid, (a, b) => {
        const ab = compareBids(a, b);
        const ba = compareBids(b, a);
        // Summed rather than negated: Math.sign(0) is +0 but -Math.sign(0) is -0, and
        // Object.is tells those apart.
        expect(Math.sign(ab) + Math.sign(ba)).toBe(0);
        expect(ab === 0).toBe(a.quantity === b.quantity && a.face === b.face);
      }),
    );
  });

  test('R-08: legalBids is strictly ascending and duplicate-free', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.constantFrom<Face>(1, 2, 3, 4, 5, 6),
        fc.boolean(),
        (q, f, palifico) => {
          const state = table(bid(q, f), palifico);
          const bids = legalBids(state);
          for (let i = 1; i < bids.length; i += 1) {
            expect(compareBids(bids[i - 1]!, bids[i]!)).toBeLessThan(0);
          }
          expect(new Set(bids.map((b) => `${String(b.quantity)}:${String(b.face)}`)).size).toBe(
            bids.length,
          );
        },
      ),
    );
  });

  test('R-13: in a palifico round the locked face admits exactly one more die', () => {
    fc.assert(
      fc.property(quantities, fc.constantFrom<Face>(1, 2, 3, 4, 5, 6), (q, f) => {
        expect(minQuantityFor(bid(q, f), f, true)).toBe(q + 1);
        for (const other of [1, 2, 3, 4, 5, 6] as Face[]) {
          if (other !== f) expect(minQuantityFor(bid(q, f), other, true)).toBeNull();
        }
      }),
    );
  });
});

describe('R-04..R-09: the legal set a client is told about', () => {
  /** Six players, five dice each. */
  const table = (standing: Bid | null, palifico = false): GameState =>
    makeState({
      hands: Object.fromEntries(ID_POOL.map((id) => [id, [1, 2, 3, 4, 5] as Face[]])),
      bids: standing === null ? [] : [{ playerId: 'a', bid: standing }],
      turnId: standing === null ? 'a' : 'b',
      palifico,
    });

  test('R-04: for any face the legal quantities are one contiguous run up to the cap', () => {
    // A client is handed six minimum quantities and draws its bid picker from them. That is
    // only a faithful description of the rules if nothing legal sits *above* an illegal
    // quantity for the same face — this is the test that says so.
    fc.assert(
      fc.property(
        fc.option(
          fc.record({
            quantity: fc.integer({ min: 1, max: 30 }),
            face: fc.constantFrom<Face>(1, 2, 3, 4, 5, 6),
          }),
          { nil: null },
        ),
        fc.boolean(),
        (standing, palifico) => {
          const state = table(standing, palifico);
          const cap = totalDiceInPlay(state);
          for (const option of bidOptionsOf(state)) {
            for (let quantity = 1; quantity <= cap; quantity += 1) {
              const legal = checkBid(state, { quantity, face: option.face }).ok;
              const expected = option.minQuantity !== null && quantity >= option.minQuantity;
              expect(legal, `(${String(quantity)},${String(option.face)})`).toBe(expected);
            }
          }
        },
      ),
      RUNS,
    );
  });

  test('R-08/R-09: the six minimums describe exactly the set legalBids enumerates', () => {
    fc.assert(
      fc.property(seeds, playerCounts, (seed, n) => {
        const { states } = playRandomMatch({ seed, playerIds: ids(n) });
        for (const state of states) {
          if (state.phase.kind !== 'bidding') continue;
          const cap = totalDiceInPlay(state);
          const fromOptions = bidOptionsOf(state).flatMap((option) => {
            // Bound to a local so the narrowing survives into the closure below.
            const min = option.minQuantity;
            if (min === null) return [];
            return Array.from({ length: cap - min + 1 }, (_, i) => ({
              quantity: min + i,
              face: option.face,
            }));
          });
          // One assertion per state, over canonical keys. Asserting membership bid by bid instead
          // meant up to 180 `expect` calls per state, each scanning a 180-element array with deep
          // equality — which passed locally at two seconds and timed out on a CI runner at five.
          const key = (bid: Bid) => `${String(bid.quantity)}:${String(bid.face)}`;
          expect(fromOptions.map(key).sort()).toEqual(legalBids(state).map(key).sort());
        }
      }),
      { numRuns: 40 },
    );
  });

  test('R-04/R-08: the top of the ladder leaves every face with no minimum at all', () => {
    // Two players on one die each, standing (2, sixes): the cap is two and six is the highest
    // face, so nothing clears it. The client is told there is nothing to bid.
    const state = makeState({
      hands: { a: [1], b: [1] },
      bids: [{ playerId: 'a', bid: bid(2, 6) }],
      turnId: 'b',
    });
    expect(bidOptionsOf(state).every((option) => option.minQuantity === null)).toBe(true);

    // One rung below, only the face above is available.
    const lower = makeState({
      hands: { a: [1], b: [1] },
      bids: [{ playerId: 'a', bid: bid(2, 5) }],
      turnId: 'b',
    });
    expect(
      bidOptionsOf(lower)
        .filter((option) => option.minQuantity !== null)
        .map((option) => option.face),
    ).toEqual([6]);
  });

  test('R-04/R-08/R-13: the options offered never depend on anybody\'s dice', () => {
    // The bid picker is drawn straight from `bidOptions`, so if those minimums shifted with the
    // contents of the cups the picker would be a window into them: a round that offered you
    // unusually little would be telling you something about what the table is holding. They are
    // derived from public facts alone — the standing bid, the locked face, and how many dice are
    // in play. Re-rolling every hand underneath a state must not move a single minimum.
    fc.assert(
      fc.property(seeds, playerCounts, seeds, (seed, n, reroll) => {
        const { states } = playRandomMatch({ seed, playerIds: ids(n) });
        const { rng } = ctx(reroll);
        for (const state of states) {
          if (state.phase.kind !== 'bidding') continue;
          const hands = Object.fromEntries(
            Object.entries(state.round.hands).map(([id, dice]) => [
              id,
              dice.map(() => (Math.floor(rng() * 6) + 1) as Face),
            ]),
          );
          const rerolled: GameState = { ...state, round: { ...state.round, hands } };
          expect(bidOptionsOf(rerolled)).toEqual(bidOptionsOf(state));
        }
      }),
      { numRuns: 40 },
    );
  });

  test('R-13: during palifico only the locked face has a minimum', () => {
    const state = makeState({
      hands: { a: [1, 2], b: [3, 4] },
      palifico: true,
      starterId: 'a',
      bids: [{ playerId: 'a', bid: bid(2, 3) }],
      turnId: 'b',
    });
    const options = bidOptionsOf(state);
    expect(options.find((option) => option.face === 3)?.minQuantity).toBe(3);
    for (const option of options) {
      if (option.face !== 3) expect(option.minQuantity, `face ${String(option.face)}`).toBeNull();
    }
  });
});
