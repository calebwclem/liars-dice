import { describe, expect, test } from 'vitest';
import { bidOptionsOf, countFace, reduce } from '../src/index.ts';
import type { Face, GameState } from '../src/types.ts';
import { bid, ctx, expectErr, makeState, unwrap } from './helpers.ts';

const dudoThenAdvance = (state: GameState, challenger = 'b') => {
  const revealing = unwrap(reduce(state, { type: 'dudo', playerId: challenger }, ctx(1, 5_000)));
  const advanced = unwrap(reduce(revealing.state, { type: 'advanceRound' }, ctx(2, 6_000)));
  return { revealing, advanced };
};

describe('R-13 the last die is not special', () => {
  test('R-13: dropping to exactly one die arms nothing and announces nothing', () => {
    // b holds 2 dice, challenges a good bid, and so loses one. Perudo would make the next
    // round palifico and hand it to b on those terms; here b starts it (R-15, because b lost
    // the die) and plays it under exactly the rules everyone else is playing under.
    const state = makeState({
      hands: { a: [4, 4], b: [4, 6], c: [2, 3] },
      bids: [{ playerId: 'a', bid: bid(3, 4) }],
      turnId: 'b',
    });
    const { revealing, advanced } = dudoThenAdvance(state);
    expect(revealing.state.players.find((p) => p.id === 'b')?.diceCount).toBe(1);
    expect(revealing.events.map((e) => e.type)).toEqual(
      expect.not.arrayContaining(['palificoArmed']),
    );
    expect(advanced.state.round.starterId).toBe('b');
    expect(advanced.state.phase).toEqual({ kind: 'bidding', turnId: 'b' });
    const roundStarted = advanced.events.find((e) => e.type === 'roundStarted');
    expect(roundStarted).not.toHaveProperty('palifico');
  });

  test('R-07/R-13: ones stay wild in the round after a player drops to one die', () => {
    const hands = { a: [1] as Face[], b: [6, 6] as Face[] };
    expect(countFace(hands, 6)).toBe(3);

    // a, on their last die, bids three sixes holding nothing but a wild one. It is good.
    const state = makeState({
      hands,
      starterId: 'a',
      bids: [{ playerId: 'a', bid: bid(3, 6) }],
      turnId: 'b',
    });
    const { revealing } = dudoThenAdvance(state);
    expect(revealing.state.lastReveal?.actualCount).toBe(3);
    expect(revealing.state.lastReveal?.bidStands).toBe(true);
    expect(revealing.state.lastReveal?.loserId).toBe('b');
  });

  test('R-13: a player on one die may open on any face, and a lone one backs all six', () => {
    // The point of keeping ones wild for the short stack. A single 1 is the best hand a
    // one-die player can hold precisely because it argues for every face equally; palifico
    // would have pinned them to whichever number the round happened to open on.
    const state = makeState({ hands: { a: [1], b: [3, 4] }, starterId: 'a' });
    for (const face of [1, 2, 3, 4, 5, 6] as Face[]) {
      expect(reduce(state, { type: 'bid', playerId: 'a', bid: bid(1, face) }, ctx()).ok).toBe(true);
    }
  });

  test('R-13: the face is never locked — a one-die player can still change it', () => {
    // a opened on threes while down to one die. Under palifico b, and then a again, would be
    // stuck on threes for the whole round. R-08 alone governs: raise the quantity, or hold it
    // and raise the face.
    const state = makeState({
      hands: { a: [1], b: [3, 4], c: [5, 6] },
      starterId: 'a',
      bids: [{ playerId: 'a', bid: bid(2, 3) }],
      turnId: 'b',
    });
    for (const next of [bid(2, 4), bid(2, 6), bid(3, 1), bid(3, 3), bid(5, 2)]) {
      expect(
        reduce(state, { type: 'bid', playerId: 'b', bid: next }, ctx()).ok,
        JSON.stringify(next),
      ).toBe(true);
    }
    // R-08 still bites in the ordinary way.
    expectErr(reduce(state, { type: 'bid', playerId: 'b', bid: bid(2, 2) }, ctx()), 'BID_TOO_LOW');
    expectErr(reduce(state, { type: 'bid', playerId: 'b', bid: bid(1, 6) }, ctx()), 'BID_TOO_LOW');
  });

  test('R-13: every face keeps a minimum quantity once a one-die player is at the table', () => {
    // What the client is offered. Palifico showed five of the six faces as unavailable; the
    // only thing that may remove a face now is the R-04 cap.
    const state = makeState({
      hands: { a: [1], b: [3, 4], c: [5, 6] },
      starterId: 'a',
      bids: [{ playerId: 'a', bid: bid(2, 3) }],
      turnId: 'b',
    });
    expect(bidOptionsOf(state)).toEqual([
      { face: 1, minQuantity: 3 },
      { face: 2, minQuantity: 3 },
      { face: 3, minQuantity: 3 },
      { face: 4, minQuantity: 2 },
      { face: 5, minQuantity: 2 },
      { face: 6, minQuantity: 2 },
    ]);
  });

  test('R-13: two players on one die each play an ordinary round', () => {
    // The endgame Perudo makes strangest. Two dice on the table, both wild-capable, every
    // face open, and the only ceiling is R-04.
    const state = makeState({ hands: { a: [1], b: [4] }, starterId: 'a' });
    expect(bidOptionsOf(state).every((option) => option.minQuantity === 1)).toBe(true);
    const opened = unwrap(reduce(state, { type: 'bid', playerId: 'a', bid: bid(2, 4) }, ctx()));
    // a claims both dice are fours; a's wild one makes that true, so b loses their last die.
    // No `advanceRound` here — the match is over, which is the whole of the endgame.
    const revealing = unwrap(reduce(opened.state, { type: 'dudo', playerId: 'b' }, ctx(1, 5_000)));
    expect(revealing.state.lastReveal?.actualCount).toBe(2);
    expect(revealing.state.lastReveal?.bidStands).toBe(true);
    expect(revealing.state.phase).toEqual({ kind: 'ended', winnerId: 'a' });
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
        { id: 'c', seat: 2, diceCount: 0 },
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
      diceCounts: { a: 2, b: 2, c: 2 },
    });
  });
});
