import { describe, expect, test } from 'vitest';
import { reduce, totalDiceInPlay } from '../src/index.ts';
import type { Face, GameEvent, GameState } from '../src/types.ts';
import { bid, ctx, expectErr, makeState, unwrap } from './helpers.ts';

const types = (events: readonly GameEvent[]): string[] => events.map((e) => e.type);

/** `a` has bid, it is `b`'s turn, and `b` is about to call dudo. */
const standoff = (
  hands: Record<string, readonly Face[]>,
  quantity: number,
  face: Face,
): GameState =>
  makeState({ hands, bids: [{ playerId: 'a', bid: bid(quantity, face) }], turnId: 'b' });

const dudo = (state: GameState, playerId = 'b') =>
  unwrap(reduce(state, { type: 'dudo', playerId }, ctx(1, 5_000)));

describe('R-10 dudo', () => {
  test('R-10: when the bid was good the challenger loses one die', () => {
    // Three 4s are on the table (two real, one wild one) against a bid of three.
    // b holds three dice. What happens on the way down to one is last-die.test.ts's business
    // (R-13: nothing happens); this is only about the die itself changing hands.
    const state = standoff({ a: [4, 4], b: [1, 6, 6], c: [2, 3] }, 3, 4);
    const { state: next, events } = dudo(state);
    const reveal = next.lastReveal!;
    expect(reveal.actualCount).toBe(3);
    expect(reveal.bidStands).toBe(true);
    expect(reveal.loserId).toBe('b');
    expect(next.players.find((p) => p.id === 'b')!.diceCount).toBe(2);
    expect(next.players.find((p) => p.id === 'a')!.diceCount).toBe(2);
    expect(types(events)).toEqual(['dudoCalled', 'diceRevealed', 'dieLost']);
  });

  test('R-10: when the bid was a lie the bidder loses one die', () => {
    const state = standoff({ a: [4, 4], b: [6, 6], c: [2, 3] }, 5, 4);
    const { state: next } = dudo(state);
    const reveal = next.lastReveal!;
    expect(reveal.actualCount).toBe(2);
    expect(reveal.bidStands).toBe(false);
    expect(reveal.loserId).toBe('a');
    expect(next.players.find((p) => p.id === 'a')!.diceCount).toBe(1);
    expect(next.players.find((p) => p.id === 'b')!.diceCount).toBe(2);
  });

  test('R-10: actualCount equal to the quantity means the bid was good — "at least"', () => {
    const state = standoff({ a: [4, 4], b: [6, 6], c: [2, 3] }, 2, 4);
    const { state: next } = dudo(state);
    expect(next.lastReveal!.actualCount).toBe(2);
    expect(next.lastReveal!.bidStands).toBe(true);
    expect(next.lastReveal!.loserId).toBe('b');
  });

  test('R-10: one die short is a lie', () => {
    const state = standoff({ a: [4, 4], b: [6, 6], c: [2, 3] }, 3, 4);
    const { state: next } = dudo(state);
    expect(next.lastReveal!.bidStands).toBe(false);
    expect(next.lastReveal!.loserId).toBe('a');
  });

  test('R-10: the reveal names the challenger, the bidder, the bid and every hand', () => {
    const hands = { a: [4, 4] as Face[], b: [1, 6] as Face[], c: [2, 3] as Face[] };
    const { state: next } = dudo(standoff(hands, 3, 4));
    const reveal = next.lastReveal!;
    expect(reveal).toMatchObject({
      roundIndex: 0,
      challengerId: 'b',
      bidderId: 'a',
      bid: bid(3, 4),
      eliminatedId: null,
      loserDiceCount: 1,
    });
    expect(reveal.hands).toEqual(hands);
  });

  test('R-10: all dice are revealed, so the count spans every player', () => {
    // The wild one in d's hand is what carries the bid.
    const state = makeState({
      hands: { a: [5], b: [2], c: [3], d: [1] },
      bids: [{ playerId: 'a', bid: bid(2, 5) }],
      turnId: 'b',
    });
    const { state: next } = dudo(state);
    expect(next.lastReveal!.actualCount).toBe(2);
    expect(next.lastReveal!.bidStands).toBe(true);
  });

  test('R-10: a challenge moves the match to the reveal phase, not straight to a new round', () => {
    const { state: next } = dudo(standoff({ a: [4, 4], b: [1, 6], c: [2, 3] }, 3, 4));
    expect(next.phase).toEqual({ kind: 'reveal' });
    expect(next.round.index).toBe(0);
    expect(next.round.bids).toHaveLength(1);
  });

  test('R-10: bidding is refused during a reveal; advanceRound is refused during bidding', () => {
    const state = standoff({ a: [4, 4], b: [1, 6], c: [2, 3] }, 3, 4);
    expectErr(reduce(state, { type: 'advanceRound' }, ctx()), 'WRONG_PHASE');
    const { state: revealing } = dudo(state);
    expectErr(
      reduce(revealing, { type: 'bid', playerId: 'c', bid: bid(4, 4) }, ctx()),
      'WRONG_PHASE',
    );
    expectErr(reduce(revealing, { type: 'dudo', playerId: 'c' }, ctx()), 'WRONG_PHASE');
  });

  test('R-10: exactly one player loses exactly one die per round', () => {
    const before = standoff({ a: [4, 4], b: [1, 6], c: [2, 3] }, 3, 4);
    const { state: after } = dudo(before);
    const deltas = before.players.map((p, i) => p.diceCount - after.players[i]!.diceCount);
    expect(deltas.filter((d) => d === 1)).toHaveLength(1);
    expect(deltas.filter((d) => d === 0)).toHaveLength(2);
    expect(totalDiceInPlay(after)).toBe(totalDiceInPlay(before) - 1);
  });

  test('R-10: an eliminated player cannot act', () => {
    const state = makeState({
      hands: { a: [4, 4], b: [1, 6] },
      diceCounts: { a: 2, b: 2, c: 0 },
      bids: [{ playerId: 'a', bid: bid(2, 4) }],
      turnId: 'b',
    });
    const withGhost: GameState = {
      ...state,
      players: [...state.players, { id: 'c', seat: 2, diceCount: 0 }],
    };
    expectErr(reduce(withGhost, { type: 'dudo', playerId: 'c' }, ctx()), 'PLAYER_ELIMINATED');
    expectErr(
      reduce(withGhost, { type: 'bid', playerId: 'c', bid: bid(3, 4) }, ctx()),
      'PLAYER_ELIMINATED',
    );
  });
});

describe('R-11 the five-dice ceiling', () => {
  test('R-11: no player ever exceeds five dice', () => {
    const state = standoff({ a: [4, 4], b: [1, 6], c: [2, 3] }, 3, 4);
    const { state: next } = dudo(state);
    for (const p of next.players) expect(p.diceCount).toBeLessThanOrEqual(next.config.maxDice);
  });

  test('R-11: no v1 rule returns a die, so dice in play only ever falls', () => {
    // Dudo is the only challenge (R-10), and it always removes exactly one die.
    const state = standoff({ a: [4, 4], b: [1, 6], c: [2, 3] }, 3, 4);
    const { state: next } = dudo(state);
    expect(totalDiceInPlay(next)).toBeLessThan(totalDiceInPlay(state));
  });
});

describe('R-12 elimination and winning', () => {
  test('R-12: a player reduced to 0 dice is eliminated', () => {
    const state = makeState({
      hands: { a: [4], b: [6, 6], c: [2, 3] },
      bids: [{ playerId: 'a', bid: bid(5, 4) }],
      turnId: 'b',
    });
    const { state: next, events } = dudo(state);
    expect(next.lastReveal!.loserId).toBe('a');
    expect(next.lastReveal!.eliminatedId).toBe('a');
    expect(next.players.find((p) => p.id === 'a')!.diceCount).toBe(0);
    expect(types(events)).toEqual(['dudoCalled', 'diceRevealed', 'dieLost', 'playerEliminated']);
  });

  test('R-12: the last player with dice wins the match', () => {
    const state = makeState({
      hands: { a: [2], b: [3] },
      bids: [{ playerId: 'a', bid: bid(1, 5) }],
      turnId: 'b',
    });
    const { state: next, events } = dudo(state);
    expect(next.phase).toEqual({ kind: 'ended', winnerId: 'b' });
    expect(next.endedAt).toBe(5_000);
    expect(types(events)).toEqual([
      'dudoCalled',
      'diceRevealed',
      'dieLost',
      'playerEliminated',
      'matchEnded',
    ]);
  });

  test('R-12: nothing is legal once the match has ended', () => {
    const state = makeState({
      hands: { a: [2], b: [3] },
      bids: [{ playerId: 'a', bid: bid(1, 5) }],
      turnId: 'b',
    });
    const { state: ended } = dudo(state);
    expectErr(reduce(ended, { type: 'bid', playerId: 'b', bid: bid(1, 2) }, ctx()), 'MATCH_ENDED');
    expectErr(reduce(ended, { type: 'dudo', playerId: 'b' }, ctx()), 'MATCH_ENDED');
    expectErr(reduce(ended, { type: 'advanceRound' }, ctx()), 'MATCH_ENDED');
  });

  test('R-12: an eliminated player is dealt no hand in the next round', () => {
    const state = makeState({
      hands: { a: [4], b: [6, 6], c: [2, 3] },
      bids: [{ playerId: 'a', bid: bid(5, 4) }],
      turnId: 'b',
    });
    const { state: revealing } = dudo(state);
    const { state: next } = unwrap(reduce(revealing, { type: 'advanceRound' }, ctx(3)));
    expect(Object.keys(next.round.hands).sort()).toEqual(['b', 'c']);
    expect(next.round.hands['a']).toBeUndefined();
  });
});
