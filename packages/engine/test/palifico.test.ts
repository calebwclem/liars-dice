import { describe, expect, test } from 'vitest';
import { countFace, reduce } from '../src/index.ts';
import type { Face, GameState } from '../src/types.ts';
import { bid, ctx, expectErr, makeState, unwrap } from './helpers.ts';

const dudoThenAdvance = (state: GameState, challenger = 'b') => {
  const revealing = unwrap(reduce(state, { type: 'dudo', playerId: challenger }, ctx(1, 5_000)));
  const advanced = unwrap(reduce(revealing.state, { type: 'advanceRound' }, ctx(2, 6_000)));
  return { revealing, advanced };
};

describe('R-13 palifico', () => {
  test('R-13: dropping from 2 dice to exactly 1 arms palifico for the next round', () => {
    // b holds 2 dice, challenges a good bid, and so loses one.
    const state = makeState({
      hands: { a: [4, 4], b: [4, 6], c: [2, 3] },
      bids: [{ playerId: 'a', bid: bid(3, 4) }],
      turnId: 'b',
    });
    const { revealing, advanced } = dudoThenAdvance(state);
    expect(revealing.state.palificoNextFor).toBe('b');
    expect(revealing.events.map((e) => e.type)).toContain('palificoArmed');
    expect(advanced.state.round.palifico).toBe(true);
    expect(advanced.state.round.starterId).toBe('b');
    expect(advanced.state.phase).toEqual({ kind: 'bidding', turnId: 'b' });
    expect(advanced.state.palificoNextFor).toBeNull();
  });

  test('R-13: dropping from 3 to 2, or 5 to 4, arms nothing', () => {
    const state = makeState({
      hands: { a: [4, 4, 4], b: [4, 6, 6], c: [2, 3] },
      bids: [{ playerId: 'a', bid: bid(4, 4) }],
      turnId: 'b',
    });
    const { revealing, advanced } = dudoThenAdvance(state);
    expect(revealing.state.palificoNextFor).toBeNull();
    expect(revealing.events.map((e) => e.type)).not.toContain('palificoArmed');
    expect(advanced.state.round.palifico).toBe(false);
  });

  test('R-13: a player triggers palifico only once per match', () => {
    // Unreachable in v1 — with calza cut, no rule returns a die, so a player passes
    // through 2 -> 1 exactly once. The flag still guards the rule, and will matter the
    // day spot-on comes back. Constructed directly for that reason.
    const state = makeState({
      hands: { a: [4, 4], b: [4, 6], c: [2, 3] },
      bids: [{ playerId: 'a', bid: bid(3, 4) }],
      turnId: 'b',
      palificoUsed: ['b'],
    });
    const { revealing, advanced } = dudoThenAdvance(state);
    expect(revealing.state.palificoNextFor).toBeNull();
    expect(advanced.state.round.palifico).toBe(false);
    expect(advanced.state.round.starterId).toBe('b'); // R-15 still applies
  });

  test('R-13: the palifico round is followed by an ordinary round', () => {
    const palifico = makeState({
      hands: { a: [4], b: [6, 6, 6], c: [2, 3] },
      palifico: true,
      starterId: 'a',
      palificoUsed: ['a'],
      bids: [{ playerId: 'a', bid: bid(2, 6) }],
      turnId: 'b',
      roundIndex: 3,
    });
    const { advanced } = dudoThenAdvance(palifico);
    expect(advanced.state.round.index).toBe(4);
    expect(advanced.state.round.palifico).toBe(false);
  });

  test('R-13: ones are not wild during a palifico round', () => {
    const hands = { a: [1, 1] as Face[], b: [6] as Face[] };
    expect(countFace(hands, 6, true)).toBe(3);
    expect(countFace(hands, 6, false)).toBe(1);

    const state = makeState({
      hands,
      palifico: true,
      starterId: 'a',
      bids: [{ playerId: 'a', bid: bid(2, 6) }],
      turnId: 'b',
    });
    const { revealing } = dudoThenAdvance(state);
    expect(revealing.state.lastReveal!.wildOnes).toBe(false);
    expect(revealing.state.lastReveal!.actualCount).toBe(1);
    expect(revealing.state.lastReveal!.bidStands).toBe(false);
    expect(revealing.state.lastReveal!.loserId).toBe('a');
  });

  test('R-13: the opening bid of a palifico round may name any face', () => {
    const state = makeState({ hands: { a: [1, 2], b: [3, 4] }, palifico: true, starterId: 'a' });
    for (const face of [1, 2, 3, 4, 5, 6] as Face[]) {
      expect(reduce(state, { type: 'bid', playerId: 'a', bid: bid(1, face) }, ctx()).ok).toBe(true);
    }
  });

  test('R-13: the opening bid locks the face for the rest of the palifico round', () => {
    const state = makeState({
      hands: { a: [1, 2], b: [3, 4] },
      palifico: true,
      starterId: 'a',
      bids: [{ playerId: 'a', bid: bid(2, 3) }],
      turnId: 'b',
    });
    expect(reduce(state, { type: 'bid', playerId: 'b', bid: bid(3, 3) }, ctx()).ok).toBe(true);
    expectErr(
      reduce(state, { type: 'bid', playerId: 'b', bid: bid(3, 4) }, ctx()),
      'PALIFICO_FACE_LOCKED',
    );
    expectErr(
      reduce(state, { type: 'bid', playerId: 'b', bid: bid(4, 6) }, ctx()),
      'PALIFICO_FACE_LOCKED',
    );
    expectErr(
      reduce(state, { type: 'bid', playerId: 'b', bid: bid(3, 1) }, ctx()),
      'PALIFICO_FACE_LOCKED',
    );
  });

  test('R-13: with the face locked, only the quantity can rise', () => {
    const state = makeState({
      hands: { a: [1, 2], b: [3, 4] },
      palifico: true,
      starterId: 'a',
      bids: [{ playerId: 'a', bid: bid(2, 3) }],
      turnId: 'b',
    });
    expectErr(reduce(state, { type: 'bid', playerId: 'b', bid: bid(2, 3) }, ctx()), 'BID_TOO_LOW');
    expectErr(reduce(state, { type: 'bid', playerId: 'b', bid: bid(1, 3) }, ctx()), 'BID_TOO_LOW');
  });

  test('R-13: a palifico round opened on ones is an ordinary quantity ladder', () => {
    // Ones are not wild here, so (2,1) is worth no more than (2,6) would be, and the
    // R-09 conversions cannot apply because the face is locked.
    const state = makeState({
      hands: { a: [1, 2], b: [1, 4] },
      palifico: true,
      starterId: 'a',
      bids: [{ playerId: 'a', bid: bid(2, 1) }],
      turnId: 'b',
    });
    expect(reduce(state, { type: 'bid', playerId: 'b', bid: bid(3, 1) }, ctx()).ok).toBe(true);
    expectErr(reduce(state, { type: 'bid', playerId: 'b', bid: bid(2, 1) }, ctx()), 'BID_TOO_LOW');
    expectErr(
      reduce(state, { type: 'bid', playerId: 'b', bid: bid(3, 2) }, ctx()),
      'PALIFICO_FACE_LOCKED',
    );
  });
});

describe('R-14 the round after an elimination', () => {
  test('R-14: the next round starts with the eliminated player’s left-hand neighbour', () => {
    // b (seat 1) holds one die, challenges a bid that turns out to be good, and is
    // eliminated; c (seat 2) starts the next round.
    const state = makeState({
      hands: { a: [4, 4], b: [6], c: [4, 3], d: [5, 5] },
      bids: [{ playerId: 'a', bid: bid(3, 4) }],
      turnId: 'b',
    });
    const { revealing, advanced } = dudoThenAdvance(state);
    expect(revealing.state.lastReveal!.eliminatedId).toBe('b');
    expect(advanced.state.round.starterId).toBe('c');
  });

  test('R-14: the search wraps around the table', () => {
    // d (seat 3) is eliminated; a (seat 0) starts.
    const state = makeState({
      hands: { a: [4, 4], b: [6, 6], c: [2, 3], d: [5] },
      bids: [{ playerId: 'd', bid: bid(3, 5) }],
      turnId: 'a',
      starterId: 'd',
    });
    const { revealing, advanced } = dudoThenAdvance(state, 'a');
    expect(revealing.state.lastReveal!.loserId).toBe('d');
    expect(revealing.state.lastReveal!.eliminatedId).toBe('d');
    expect(advanced.state.round.starterId).toBe('a');
  });

  test('R-14: players already out are skipped', () => {
    // b (seat 1) is eliminated this round and c (seat 2) was already out, so d starts.
    const state = makeState({
      hands: { a: [4, 4], b: [6], d: [4, 5] },
      diceCounts: { a: 2, b: 1, c: 0, d: 2 },
      bids: [{ playerId: 'a', bid: bid(3, 4) }],
      turnId: 'b',
    });
    const withGhost: GameState = {
      ...state,
      players: [
        state.players[0]!,
        state.players[1]!,
        { id: 'c', seat: 2, diceCount: 0, palificoUsed: false },
        { ...state.players[2]!, seat: 3 },
      ],
    };
    const { advanced } = dudoThenAdvance(withGhost);
    expect(advanced.state.round.starterId).toBe('d');
  });
});

describe('R-15 the round after a challenge', () => {
  test('R-15: the player who lost the die starts the next round — the challenger', () => {
    const state = makeState({
      hands: { a: [4, 4], b: [4, 6], c: [2, 3] },
      bids: [{ playerId: 'a', bid: bid(3, 4) }],
      turnId: 'b',
    });
    const { revealing, advanced } = dudoThenAdvance(state);
    expect(revealing.state.lastReveal!.loserId).toBe('b');
    expect(advanced.state.round.starterId).toBe('b');
    expect(advanced.state.phase).toEqual({ kind: 'bidding', turnId: 'b' });
  });

  test('R-15: the player who lost the die starts the next round — the bidder', () => {
    const state = makeState({
      hands: { a: [4, 4], b: [6, 6], c: [2, 3] },
      bids: [{ playerId: 'a', bid: bid(5, 4) }],
      turnId: 'b',
    });
    const { revealing, advanced } = dudoThenAdvance(state);
    expect(revealing.state.lastReveal!.loserId).toBe('a');
    expect(advanced.state.round.starterId).toBe('a');
  });

  test('R-15: a new round re-rolls every surviving hand and clears the bid history', () => {
    const state = makeState({
      hands: { a: [4, 4], b: [4, 6, 6], c: [2, 3] },
      bids: [{ playerId: 'a', bid: bid(3, 4) }],
      turnId: 'b',
    });
    const { advanced } = dudoThenAdvance(state);
    expect(advanced.state.round.index).toBe(1);
    expect(advanced.state.round.bids).toEqual([]);
    expect(advanced.state.round.hands['b']).toHaveLength(2);
    expect(advanced.state.round.hands['a']).toHaveLength(2);
    expect(advanced.state.lastReveal).not.toBeNull(); // kept for a late-joining client
    const roundStarted = advanced.events.find((e) => e.type === 'roundStarted');
    expect(roundStarted).toEqual({
      type: 'roundStarted',
      index: 1,
      starterId: 'b',
      palifico: false,
      diceCounts: { a: 2, b: 2, c: 2 },
    });
  });
});
