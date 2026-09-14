import { afterEach, describe, expect, test, vi } from 'vitest';
import { createMatch, redactFor, reduce } from '../src/index.ts';
import type { Face, GameEvent } from '../src/types.ts';
import { bid, ctx, makeState, playRandomMatch, unwrap } from './helpers.ts';

/**
 * Every path in `value` that holds an array of die faces. Used to prove a shape contains
 * no hand other than the ones it is allowed to contain — a structural claim, rather than
 * "we remembered to delete the right key".
 */
function dicePaths(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) {
    const faces = value.every((v) => typeof v === 'number' && v >= 1 && v <= 6);
    if (value.length > 0 && faces) return [path];
    return value.flatMap((v, i) => dicePaths(v, `${path}[${String(i)}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) =>
      dicePaths(v, path === '' ? k : `${path}.${k}`),
    );
  }
  return [];
}

const HANDS: Record<string, readonly Face[]> = {
  a: [1, 2, 3, 4, 5],
  b: [6, 6, 6, 6, 6],
  c: [2, 2, 2, 2, 2],
  d: [3, 3, 3, 3, 3],
};

describe('R-03 / R-20 redaction', () => {
  test('R-03: a player sees only their own dice', () => {
    const state = makeState({ hands: HANDS });
    const view = redactFor(state, 'b');
    expect(view.you).toEqual({ id: 'b', seat: 1, dice: [6, 6, 6, 6, 6] });
    expect(dicePaths(view)).toEqual(['you.dice']);
  });

  test('R-20: no other player’s dice appear anywhere in a PlayerView before a reveal', () => {
    const state = makeState({
      hands: HANDS,
      bids: [{ playerId: 'a', bid: bid(3, 6) }],
      turnId: 'b',
    });
    for (const viewer of ['a', 'b', 'c', 'd']) {
      const view = redactFor(state, viewer);
      // The only face array reachable from the view is the viewer's own hand.
      expect(dicePaths(view), `viewer ${viewer}`).toEqual(['you.dice']);
      expect(view.you?.dice).toEqual(HANDS[viewer]);
      // And the raw hands map is absent rather than filtered, so nothing can be left behind.
      expect('hands' in view.round).toBe(false);
      expect(JSON.stringify(view)).not.toContain('hands');
    }
  });

  test('R-20: the redacted view still carries everything a client needs to render', () => {
    const state = makeState({
      hands: HANDS,
      bids: [{ playerId: 'a', bid: bid(3, 6) }],
      turnId: 'b',
    });
    const view = redactFor(state, 'c');
    expect(view.players).toEqual([
      { id: 'a', seat: 0, diceCount: 5, eliminated: false, palificoUsed: false },
      { id: 'b', seat: 1, diceCount: 5, eliminated: false, palificoUsed: false },
      { id: 'c', seat: 2, diceCount: 5, eliminated: false, palificoUsed: false },
      { id: 'd', seat: 3, diceCount: 5, eliminated: false, palificoUsed: false },
    ]);
    expect(view.round.bids).toEqual([{ playerId: 'a', bid: bid(3, 6) }]);
    expect(view.phase).toEqual({ kind: 'bidding', turnId: 'b' });
    expect(view.totalDiceInPlay).toBe(20);
    expect(view.round.lockedFace).toBeNull();
  });

  test('R-10 / R-20: after a reveal every hand is public, and only then', () => {
    const state = makeState({
      hands: HANDS,
      bids: [{ playerId: 'a', bid: bid(3, 6) }],
      turnId: 'b',
    });
    const before = redactFor(state, 'c');
    expect(before.lastReveal).toBeNull();

    const { state: revealed } = unwrap(reduce(state, { type: 'dudo', playerId: 'b' }, ctx()));
    const after = redactFor(revealed, 'c');
    expect(after.lastReveal?.hands).toEqual(HANDS);
    expect(dicePaths(after).sort()).toEqual([
      'lastReveal.hands.a',
      'lastReveal.hands.b',
      'lastReveal.hands.c',
      'lastReveal.hands.d',
      'you.dice',
    ]);
  });

  test('R-20: someone who is not in the match gets no dice at all', () => {
    const view = redactFor(makeState({ hands: HANDS }), 'nobody');
    expect(view.you).toBeNull();
    expect(dicePaths(view)).toEqual([]);
  });

  test('R-20: a full match never leaks a hand through any view at any point', () => {
    const { states } = playRandomMatch({ seed: 4, playerIds: ['a', 'b', 'c', 'd'] });
    for (const state of states) {
      for (const viewer of ['a', 'b', 'c', 'd']) {
        const view = redactFor(state, viewer);
        const leaked = dicePaths(view).filter(
          (p) => p !== 'you.dice' && !p.startsWith('lastReveal.hands.'),
        );
        expect(leaked).toEqual([]);
        // A reveal is public, but only of the round it belongs to.
        if (view.lastReveal !== null && state.phase.kind === 'bidding') {
          expect(view.lastReveal.roundIndex).toBeLessThan(view.round.index);
        }
      }
    }
  });

  test('R-20: no event carries a die face except diceRevealed', () => {
    const { events } = playRandomMatch({ seed: 11, playerIds: ['a', 'b', 'c', 'd'] });
    const offenders = events
      .filter((e: GameEvent) => e.type !== 'diceRevealed')
      .flatMap((e) => dicePaths(e, e.type));
    expect(offenders).toEqual([]);
    // ...and the reveal events that do carry hands are exactly the challenges played.
    expect(events.filter((e) => e.type === 'diceRevealed').length).toBe(
      events.filter((e) => e.type === 'dudoCalled').length,
    );
  });
});

describe('R-20 the engine has no clock and no entropy of its own', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('R-20: dice come from ctx.rng — Math.random is never called', () => {
    const boom = (): never => {
      throw new Error('the engine reached for ambient randomness');
    };
    const randomSpy = vi.spyOn(Math, 'random').mockImplementation(boom);
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(boom);

    // Everything inside this window is synchronous engine code.
    const result = playRandomMatch({ seed: 5, playerIds: ['a', 'b', 'c'] });

    vi.restoreAllMocks();
    expect(randomSpy).not.toHaveBeenCalled();
    expect(nowSpy).not.toHaveBeenCalled();
    expect(result.final.phase.kind).toBe('ended');
  });

  test('R-20: timestamps come from ctx.now', () => {
    const opened = unwrap(createMatch({ matchId: 'M', playerIds: ['a', 'b'] }, ctx(1, 1_234)));
    expect(opened.state.startedAt).toBe(1_234);
    expect(opened.state.endedAt).toBeNull();
  });
});
