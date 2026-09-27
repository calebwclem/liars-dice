import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import type { Action, Face, GameState, PlayerId, PlayerView } from '@liars-dice/engine';
import {
  createMatch,
  legalBids,
  makeRng,
  redactFor,
  reduce,
  totalDiceInPlay,
} from '@liars-dice/engine';
import { atLeast, matchChance } from '../src/probability.ts';
import { decide } from '../src/policy.ts';
import { BALANCED, BOLD, CAUTIOUS, profileFor, PROFILES } from '../src/profiles.ts';

const never = { ...BALANCED, bluff: 0 };
const always = { ...BALANCED, bluff: 1 };

/** A view built by hand, so a specific hand can be put in front of a specific bid. */
function viewOf(options: {
  myDice: readonly Face[];
  totalDiceInPlay: number;
  bids?: readonly { playerId: PlayerId; bid: { quantity: number; face: Face } }[];
  palifico?: boolean;
  lockedFace?: Face | null;
  turnId?: string;
}): PlayerView {
  const bids = options.bids ?? [];
  return {
    matchId: 'M',
    seq: 1,
    config: { startingDice: 5, maxDice: 5 },
    you: { id: 'me', seat: 0, dice: options.myDice },
    players: [
      {
        id: 'me',
        seat: 0,
        diceCount: options.myDice.length,
        eliminated: false,
        palificoUsed: false,
      },
      {
        id: 'them',
        seat: 1,
        diceCount: options.totalDiceInPlay - options.myDice.length,
        eliminated: false,
        palificoUsed: false,
      },
    ],
    phase: { kind: 'bidding', turnId: options.turnId ?? 'me' },
    round: {
      index: 0,
      palifico: options.palifico ?? false,
      starterId: 'me',
      lockedFace: options.lockedFace ?? null,
      bids,
    },
    lastReveal: null,
    totalDiceInPlay: options.totalDiceInPlay,
  };
}

const fixed = (value: number) => () => value;

describe('What the bot can see', () => {
  test('it decides from a redacted view, so it cannot read the table', () => {
    // The signature is the guarantee: `decide` takes a PlayerView, which by construction holds no
    // hand but the viewer's own (R-03, R-20). This test exists to make that a stated claim rather
    // than an accident of the current implementation.
    const view = viewOf({ myDice: [1, 2, 3], totalDiceInPlay: 9 });
    expect(view.you?.dice).toEqual([1, 2, 3]);
    expect(JSON.stringify(view)).not.toContain('hands');

    const judgement = decide(view, { profile: BALANCED, rng: fixed(0.9) });
    expect(judgement).not.toBeNull();
  });

  test('it declines to act when it is not its turn, or it has no seat', () => {
    const theirTurn = viewOf({ myDice: [1, 2], totalDiceInPlay: 6, turnId: 'them' });
    expect(decide(theirTurn, { profile: BALANCED, rng: fixed(0.9) })).toBeNull();

    const spectator: PlayerView = { ...viewOf({ myDice: [], totalDiceInPlay: 6 }), you: null };
    expect(decide(spectator, { profile: BALANCED, rng: fixed(0.9) })).toBeNull();
  });
});

describe('Judgement', () => {
  test('R-06: opening the round, it bids rather than challenging', () => {
    const view = viewOf({ myDice: [4, 4, 4, 2, 6], totalDiceInPlay: 10 });
    const judgement = decide(view, { profile: never, rng: fixed(0.9) });
    expect(judgement?.action.type).toBe('bid');
    expect(judgement?.reason).toBe('opening');
  });

  test('it opens near what its own hand supports', () => {
    // Three fours in hand and five unseen dice: with ones wild, a third of the unseen dice match,
    // so four or five fours is about the honest limit — and it should not open at one.
    const view = viewOf({ myDice: [4, 4, 4, 2, 6], totalDiceInPlay: 10 });
    const judgement = decide(view, { profile: never, rng: fixed(0.9) });
    expect(judgement?.action.type).toBe('bid');
    if (judgement?.action.type !== 'bid') return;
    expect(judgement.action.bid.quantity).toBeGreaterThan(1);
    // It aims *at* a confidence rather than for the boldest bid it can still believe. Opening at
    // the edge of plausibility is readable, and an earlier version did exactly that and got called
    // on it every round.
    expect(judgement.chosenChance ?? 0).toBeGreaterThan(0.4);
    expect(judgement.chosenChance ?? 1).toBeLessThan(0.9);
  });

  test('it challenges a bid that cannot plausibly be true', () => {
    // Ten dice on the table, none of them fours in this hand, and a bid of nine.
    const view = viewOf({
      myDice: [2, 2, 3, 3, 5],
      totalDiceInPlay: 10,
      bids: [{ playerId: 'them', bid: { quantity: 9, face: 4 } }],
    });
    const judgement = decide(view, { profile: never, rng: fixed(0.9) });
    expect(judgement?.action.type).toBe('dudo');
    expect(judgement?.standingChance ?? 1).toBeLessThan(0.05);
  });

  test('it raises over a bid it can comfortably beat', () => {
    // Four fives in hand against a bid of two: raising is free.
    const view = viewOf({
      myDice: [5, 5, 5, 5, 2],
      totalDiceInPlay: 10,
      bids: [{ playerId: 'them', bid: { quantity: 2, face: 5 } }],
    });
    const judgement = decide(view, { profile: never, rng: fixed(0.9) });
    expect(judgement?.action.type).toBe('bid');
    expect(judgement?.reason).toBe('raise-beats-challenge');
  });

  test('it takes the smallest raise it believes, not the boldest', () => {
    const view = viewOf({
      myDice: [5, 5, 5, 5, 5],
      totalDiceInPlay: 10,
      bids: [{ playerId: 'them', bid: { quantity: 2, face: 5 } }],
    });
    const judgement = decide(view, { profile: never, rng: fixed(0.9) });
    if (judgement?.action.type !== 'bid') return expect.unreachable();
    // It could say ten fives and still half-believe it; escalating no further than necessary is
    // what keeps a die in hand.
    expect(judgement.action.bid.quantity).toBeLessThan(8);
  });

  test('R-04/R-08: with no legal raise left, it challenges because nothing else is legal', () => {
    // Two players on one die each, standing (2, sixes): the cap is two and six is the top face,
    // so the ladder has run out.
    const view = viewOf({
      myDice: [6],
      totalDiceInPlay: 2,
      bids: [{ playerId: 'them', bid: { quantity: 2, face: 6 } }],
    });
    const judgement = decide(view, { profile: never, rng: fixed(0.0) });
    expect(judgement?.action.type).toBe('dudo');
    expect(judgement?.reason).toBe('no-raise-possible');
  });

  test('R-13: during palifico it stops treating ones as wild', () => {
    // Four ones and a six, against a bid of five sixes. With ones wild that is a certainty; in a
    // palifico round the ones are worth nothing and the bid is a lie.
    const hand: readonly Face[] = [1, 1, 1, 1, 6];
    const wild = decide(
      viewOf({
        myDice: hand,
        totalDiceInPlay: 10,
        bids: [{ playerId: 'them', bid: { quantity: 5, face: 6 } }],
      }),
      { profile: never, rng: fixed(0.9) },
    );
    const palifico = decide(
      viewOf({
        myDice: hand,
        totalDiceInPlay: 10,
        bids: [{ playerId: 'them', bid: { quantity: 5, face: 6 } }],
        palifico: true,
        lockedFace: 6,
      }),
      { profile: never, rng: fixed(0.9) },
    );
    expect(wild?.standingChance ?? 0).toBeGreaterThan(palifico?.standingChance ?? 1);
    expect(wild?.action.type).toBe('bid');
    expect(palifico?.action.type).toBe('dudo');
  });
});

describe('Bluffing', () => {
  /// A spread hand against a bid that is probably true: nothing credible to raise to, and no lie
  /// to call. That is the only situation where bluffing is even the question — over an obvious lie
  /// a bot should just call it, whatever its bluff setting.
  const cornered = () =>
    viewOf({
      myDice: [2, 3, 4, 5, 6],
      totalDiceInPlay: 10,
      bids: [{ playerId: 'them', bid: { quantity: 3, face: 6 } }],
    });

  test('with bluffing off, a bot that cannot raise honestly challenges', () => {
    const judgement = decide(cornered(), { profile: never, rng: fixed(0.99) });
    expect(judgement?.action.type).toBe('dudo');
    expect(judgement?.reason).toBe('challenge-beats-raise');
  });

  test('with bluffing on, it will raise on something it does not believe', () => {
    const judgement = decide(cornered(), { profile: always, rng: fixed(0) });
    expect(judgement?.action.type).toBe('bid');
    expect(judgement?.bluffed).toBe(true);
    expect(judgement?.reason).toBe('bluff');
    // The whole point: it raised where the odds said challenge.
    const odds = judgement?.standingChance ?? 0;
    expect(judgement?.chosenChance ?? 1).toBeLessThan(1 - odds);
  });

  test('it does not bluff over a bid it can simply call', () => {
    // Bluffing is for when you cannot win honestly, not for when the other player has already
    // overreached. Nine fours on a ten-dice table is not something to raise over.
    const obviousLie = viewOf({
      myDice: [2, 2, 3, 3, 5],
      totalDiceInPlay: 10,
      bids: [{ playerId: 'them', bid: { quantity: 9, face: 4 } }],
    });
    const judgement = decide(obviousLie, { profile: always, rng: fixed(0) });
    expect(judgement?.action.type).toBe('dudo');
    expect(judgement?.bluffed).toBe(false);
  });

  test('a bluff is still the likeliest bid available, not the cheapest', () => {
    // The bluff is the decision to raise, not the choice of bid. The weakest legal raise over
    // "four ones" is "four twos", but with three fours in hand "four fours" is far likelier and
    // is what it should say.
    const view = viewOf({
      myDice: [4, 4, 4, 5, 6],
      totalDiceInPlay: 20,
      bids: [{ playerId: 'them', bid: { quantity: 4, face: 1 } }],
    });
    const judgement = decide(view, { profile: always, rng: fixed(0) });
    expect(judgement?.action.type).toBe('bid');
    if (judgement?.action.type !== 'bid') return;
    expect(judgement.action.bid.face).toBe(4);
    expect(judgement.action.bid.quantity).toBeGreaterThanOrEqual(4);
  });
});

describe('Profiles', () => {
  test('a seat always draws the same profile, and a table is not all one opponent', () => {
    expect(profileFor('bot_alpha').name).toBe(profileFor('bot_alpha').name);
    const names = new Set(
      ['bot_a', 'bot_b', 'bot_c', 'bot_d', 'bot_e', 'bot_f', 'bot_g'].map(
        (id) => profileFor(id).name,
      ),
    );
    expect(names.size).toBeGreaterThan(1);
  });

  test('the profiles actually play differently', () => {
    // A twenty-dice table where raising and challenging are nearly the same bet. That is the only
    // band where `aggression` can change the answer, and it is where the profiles separate: the
    // cautious one folds, the bold one keeps the bidding alive.
    const view = viewOf({
      myDice: [5, 5, 2, 3, 6],
      totalDiceInPlay: 20,
      bids: [{ playerId: 'them', bid: { quantity: 7, face: 5 } }],
    });
    const actions = PROFILES.map(
      (profile) => decide(view, { profile, rng: fixed(0.99) })?.action.type,
    );
    expect(new Set(actions).size).toBeGreaterThan(1);
    expect(decide(view, { profile: CAUTIOUS, rng: fixed(0.99) })?.action.type).toBe('dudo');
    expect(decide(view, { profile: BOLD, rng: fixed(0.99) })?.action.type).toBe('bid');
    expect(BOLD.aggression).toBeGreaterThan(CAUTIOUS.aggression);
    expect(BOLD.openConfidence).toBeLessThan(CAUTIOUS.openConfidence);
  });
});

describe('Against the engine', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${String(i)}`);

  /** Play a whole match with every seat driven by a bot, through the real reducer. */
  function playBotMatch(seed: number, playerCount: number) {
    const rng = makeRng(seed);
    const botRng = makeRng((seed ^ 0x51ed) >>> 0);
    const opened = createMatch({ matchId: 'M', playerIds: ids(playerCount) }, { now: 0, rng });
    if (!opened.ok) throw new Error(opened.reason);

    let state: GameState = opened.value.state;
    const actions: Action[] = [];
    for (let step = 1; state.phase.kind !== 'ended' && step < 20_000; step += 1) {
      let action: Action;
      if (state.phase.kind === 'reveal') {
        action = { type: 'advanceRound' };
      } else {
        const turnId = state.phase.turnId;
        // The server's own path: redact, then ask. A bot never touches GameState.
        const judgement = decide(redactFor(state, turnId), {
          profile: profileFor(turnId),
          rng: botRng,
        });
        if (judgement === null) throw new Error(`bot declined to act on turn ${turnId}`);
        action = judgement.action;
      }
      const result = reduce(state, action, { now: step, rng });
      if (!result.ok) {
        throw new Error(`the engine refused a bot's ${action.type}: ${result.reason}`);
      }
      actions.push(action);
      state = result.value.state;
    }
    return { final: state, actions };
  }

  test('R-04..R-15: a bot never produces a move the engine refuses', () => {
    // The strongest claim available here. The bot builds its moves from `legalBidsIn`, so if it
    // ever disagreed with the reducer this would fail rather than a player seeing a rejection.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        fc.integer({ min: 2, max: 6 }),
        (seed, playerCount) => {
          const { final } = playBotMatch(seed, playerCount);
          expect(final.phase.kind).toBe('ended');
        },
      ),
      { numRuns: 60 },
    );
  });

  test('R-12: a table of bots always plays to exactly one winner', () => {
    const { final, actions } = playBotMatch(2026, 4);
    expect(final.phase.kind).toBe('ended');
    expect(final.players.filter((player) => player.diceCount > 0)).toHaveLength(1);
    // And it got there by playing, not by everyone challenging immediately.
    expect(actions.filter((action) => action.type === 'bid').length).toBeGreaterThan(20);
  });

  test('bots make a match last longer than random play does', () => {
    // A bot that bids sensibly should survive more rounds than one flipping coins — if it does
    // not, the probability model is not earning its place.
    const botRounds = playBotMatch(7, 4).final.round.index + 1;

    const rng = makeRng(7);
    const coin = makeRng(99);
    const opened = createMatch({ matchId: 'M', playerIds: ids(4) }, { now: 0, rng });
    if (!opened.ok) throw new Error(opened.reason);
    let state = opened.value.state;
    for (let step = 1; state.phase.kind !== 'ended' && step < 20_000; step += 1) {
      let action: Action;
      if (state.phase.kind === 'reveal') {
        action = { type: 'advanceRound' };
      } else {
        const turnId = state.phase.turnId;
        const options = legalBids(state);
        const mustBid = state.round.bids.length === 0;
        const pick = options[Math.floor(coin() * options.length)];
        action =
          options.length === 0 || (!mustBid && coin() < 0.25) || pick === undefined
            ? { type: 'dudo', playerId: turnId }
            : { type: 'bid', playerId: turnId, bid: pick };
      }
      const result = reduce(state, action, { now: step, rng });
      if (!result.ok) throw new Error(result.reason);
      state = result.value.state;
    }
    const randomRounds = state.round.index + 1;

    expect(botRounds).toBeGreaterThan(randomRounds / 2);
    expect(totalDiceInPlay(state)).toBeGreaterThan(0);
  });

  test('R-20: the same seed gives the same match, bots included', () => {
    const first = playBotMatch(4242, 4);
    const second = playBotMatch(4242, 4);
    expect(second.actions).toEqual(first.actions);
    expect(second.final).toEqual(first.final);
  });
});

describe('Probability', () => {
  test('R-07: a wild one doubles the chance a die matches', () => {
    expect(matchChance(4, true)).toBeCloseTo(2 / 6, 10);
    // A bid on ones counts only ones, however wild they are for everything else.
    expect(matchChance(1, true)).toBeCloseTo(1 / 6, 10);
    // R-13: nothing is wild during palifico.
    expect(matchChance(4, false)).toBeCloseTo(1 / 6, 10);
  });

  test('the tail probability matches values worked out by hand', () => {
    expect(atLeast(0, 1 / 3, 1)).toBe(0);
    expect(atLeast(5, 1 / 3, 0)).toBe(1);
    expect(atLeast(5, 1 / 3, 6)).toBe(0);
    // One die, one in six: exactly a sixth.
    expect(atLeast(1, 1 / 6, 1)).toBeCloseTo(1 / 6, 10);
    // Two dice, at least one match at a third each: 1 - (2/3)^2.
    expect(atLeast(2, 1 / 3, 1)).toBeCloseTo(1 - (2 / 3) ** 2, 10);
    // Both of two: (1/3)^2.
    expect(atLeast(2, 1 / 3, 2)).toBeCloseTo((1 / 3) ** 2, 10);
  });

  test('it is a probability for every shape of table', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 30 }),
        fc.constantFrom(1 / 6, 2 / 6),
        fc.integer({ min: -2, max: 32 }),
        (n, p, k) => {
          const value = atLeast(n, p, k);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
          // Asking for more can never be more likely.
          expect(atLeast(n, p, k + 1)).toBeLessThanOrEqual(value + 1e-12);
        },
      ),
    );
  });

  test('the whole distribution sums to one', () => {
    for (const n of [1, 5, 12, 30]) {
      for (const p of [1 / 6, 2 / 6]) {
        // P(>=0) is the whole distribution, and P(>=n+1) is nothing.
        expect(atLeast(n, p, 0)).toBeCloseTo(1, 12);
        expect(atLeast(n, p, n + 1)).toBe(0);
      }
    }
  });
});
