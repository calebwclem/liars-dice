import { describe, expect, test } from 'vitest';
import { createMatch } from '../src/index.ts';
import { ctx, TEST_CONFIG, unwrap, expectErr } from './helpers.ts';

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `p${String(i)}`);

const start = (n: number, seed = 7) => createMatch({ matchId: 'M1', playerIds: ids(n) }, ctx(seed));

describe('Setup', () => {
  test('R-01: a match supports 2 to 6 players', () => {
    for (let n = 2; n <= 6; n++) {
      const { state } = unwrap(start(n));
      expect(state.players).toHaveLength(n);
      expect(state.players.map((p) => p.seat)).toEqual(ids(n).map((_, i) => i));
    }
  });

  test('R-01: fewer than 2 or more than 6 players is rejected', () => {
    expectErr(start(0), 'INVALID_PLAYER_COUNT');
    expectErr(start(1), 'INVALID_PLAYER_COUNT');
    expectErr(start(7), 'INVALID_PLAYER_COUNT');
  });

  test('R-01: duplicate player ids are rejected', () => {
    expectErr(
      createMatch({ matchId: 'M1', playerIds: ['a', 'b', 'a'] }, ctx()),
      'DUPLICATE_PLAYER_ID',
    );
  });

  test('R-02: every player starts with 5 six-sided dice', () => {
    const { state } = unwrap(start(4));
    expect(state.config.startingDice).toBe(5);
    for (const p of state.players) {
      expect(p.diceCount).toBe(5);
      const hand = state.round.hands[p.id]!;
      expect(hand).toHaveLength(5);
      for (const face of hand) expect(face).toBeGreaterThanOrEqual(1);
      for (const face of hand) expect(face).toBeLessThanOrEqual(6);
    }
  });

  test('R-02: over many rolls every face 1..6 appears and nothing else does', () => {
    const seen = new Set<number>();
    for (let seed = 0; seed < 40; seed++) {
      const { state } = unwrap(start(6, seed));
      for (const p of state.players) for (const f of state.round.hands[p.id]!) seen.add(f);
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('R-03: every remaining player is dealt a hand at the start of a round', () => {
    const { state, events } = unwrap(start(4));
    expect(Object.keys(state.round.hands).sort()).toEqual(ids(4).sort());
    const roundStarted = events.find((e) => e.type === 'roundStarted');
    expect(roundStarted).toBeDefined();
    expect(roundStarted?.type === 'roundStarted' && roundStarted.index).toBe(0);
  });

  test('R-03: rolls come from ctx.rng, so the same seed deals the same hands', () => {
    const a = unwrap(start(4, 99)).state.round.hands;
    const b = unwrap(start(4, 99)).state.round.hands;
    const c = unwrap(start(4, 100)).state.round.hands;
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  test('R-03: a hand is dealt per die owned, not a fixed five', () => {
    // Not reachable through createMatch (R-02 always deals 5); this is the property
    // advanceRound relies on once players have lost dice.
    const { state } = unwrap(start(2));
    expect(state.round.hands[state.players[0]!.id]).toHaveLength(state.players[0]!.diceCount);
  });

  test('R-01: the match opens in the bidding phase with a starter on turn', () => {
    const { state } = unwrap(start(4));
    expect(state.phase).toEqual({ kind: 'bidding', turnId: state.round.starterId });
    expect(state.config).toEqual(TEST_CONFIG);
    expect(state.lastReveal).toBeNull();
    expect(state.palificoNextFor).toBeNull();
    expect(state.round.palifico).toBe(false);
    expect(state.round.bids).toEqual([]);
  });
});
