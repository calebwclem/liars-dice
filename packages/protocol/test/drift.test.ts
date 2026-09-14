import { describe, expect, test } from 'vitest';
import type {
  Bid as EngineBid,
  ErrorReason as EngineErrorReasonType,
  Face as EngineFace,
  GameEvent as EngineGameEvent,
  GameState,
  PlayerView as EnginePlayerView,
} from '@liars-dice/engine';
import { createMatch, legalBids, makeRng, redactFor, reduce } from '@liars-dice/engine';
import {
  EngineErrorReasonSchema,
  FaceSchema,
  GameEventSchema,
  PlayerViewSchema,
  type EngineErrorReason,
  type Face,
  type GameEvent,
  type PlayerView,
} from '../src/index.ts';

/**
 * These schemas describe shapes the engine defines, in a package that deliberately does not
 * depend on the engine at runtime. That duplication is only safe if something fails loudly
 * when the two drift apart, which is what this file is.
 *
 * Two independent checks, because each catches what the other misses:
 *
 *  1. Type level — a renamed, added, or removed field is a compile error, even for a shape
 *     no test happens to construct.
 *  2. Runtime — every snapshot and event of a real match is parsed by its schema, which
 *     catches a value the types allow but the schema rejects (a stricter `min`, a missing
 *     `nullable`, a record key rule).
 */

/**
 * Deep-mutable. Both sides are readonly — the engine's by hand, the protocol's via
 * `DeepReadonly` — so the comparison strips the modifiers and checks the structure, which
 * is where drift actually happens.
 */
type Mutable<T> = T extends readonly (infer E)[]
  ? Mutable<E>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;

/**
 * Invariant equality: `Equals<A, B>` is true only if A and B are the same type, not merely
 * assignable in one direction. The single-use type parameters are the mechanism — the
 * comparison works precisely because two generic signatures are only identical when their
 * conditional bodies are — so the lint rule that objects to them is off for this block.
 */
/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const assertEquals = <T extends true>(): T => true as T;
/* eslint-enable @typescript-eslint/no-unnecessary-type-parameters */

describe('Schemas match the engine at the type level', () => {
  test('PlayerView', () => {
    expect(assertEquals<Equals<Mutable<PlayerView>, Mutable<EnginePlayerView>>>()).toBe(true);
  });

  test('GameEvent', () => {
    expect(assertEquals<Equals<Mutable<GameEvent>, Mutable<EngineGameEvent>>>()).toBe(true);
  });

  test('Face and Bid', () => {
    expect(assertEquals<Equals<Mutable<Face>, EngineFace>>()).toBe(true);
    expect(assertEquals<Equals<Mutable<EngineBid>, { quantity: number; face: Face }>>()).toBe(true);
  });

  test('ErrorReason', () => {
    // Every engine reason code is in the enum and the enum invents none.
    expect(assertEquals<Equals<Mutable<EngineErrorReason>, EngineErrorReasonType>>()).toBe(true);
  });
});

describe('Schemas accept real engine output', () => {
  /** Drive a match with legal random play, collecting everything a client would be sent. */
  const playMatch = (seed: number, playerIds: readonly string[]) => {
    const rng = makeRng(seed);
    const botRng = makeRng((seed ^ 0x5bf0_3635) >>> 0);
    const opened = createMatch({ matchId: 'M', playerIds }, { now: 0, rng });
    if (!opened.ok) throw new Error(opened.reason);

    let state: GameState = opened.value.state;
    const states: GameState[] = [state];
    const events: EngineGameEvent[] = [...opened.value.events];

    for (let step = 1; state.phase.kind !== 'ended' && step < 20_000; step += 1) {
      const action =
        state.phase.kind === 'reveal'
          ? ({ type: 'advanceRound' } as const)
          : nextAction(state, botRng);
      const result = reduce(state, action, { now: step, rng });
      if (!result.ok) throw new Error(`illegal action: ${result.reason}`);
      state = result.value.state;
      states.push(state);
      events.push(...result.value.events);
    }
    return { states, events, final: state };
  };

  const nextAction = (state: GameState, rng: () => number) => {
    if (state.phase.kind !== 'bidding') return { type: 'advanceRound' } as const;
    const playerId = state.phase.turnId;
    const options = legalBids(state);
    const mustBid = state.round.bids.length === 0;
    if (options.length === 0) return { type: 'dudo', playerId } as const;
    if (!mustBid && rng() < 0.25) return { type: 'dudo', playerId } as const;
    const pick = options[Math.min(Math.floor(rng() ** 3 * 10), options.length - 1)];
    if (pick === undefined) return { type: 'dudo', playerId } as const;
    return { type: 'bid', playerId, bid: pick } as const;
  };

  test('every PlayerView of a full match parses, for every viewer', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const { states, final } = playMatch(31, ids);
    expect(final.phase.kind).toBe('ended');

    let parsed = 0;
    for (const state of states) {
      for (const viewer of [...ids, 'spectator']) {
        const view = redactFor(state, viewer);
        // Parse the JSON, not the object: that is what actually crosses the socket, and it
        // is where a Map, a Date, or an undefined would surface.
        const wire: unknown = JSON.parse(JSON.stringify(view));
        const result = PlayerViewSchema.safeParse(wire);
        if (!result.success) {
          expect.unreachable(`view for ${viewer} rejected: ${result.error.message}`);
        }
        expect(result.data).toEqual(wire);
        parsed += 1;
      }
    }
    expect(parsed).toBeGreaterThan(100);
  });

  test('every GameEvent of a full match parses', () => {
    const { events } = playMatch(32, ['a', 'b', 'c', 'd', 'e', 'f']);
    const seen = new Set<string>();
    for (const event of events) {
      const wire: unknown = JSON.parse(JSON.stringify(event));
      const result = GameEventSchema.safeParse(wire);
      if (!result.success) {
        expect.unreachable(`${event.type} rejected: ${result.error.message}`);
      }
      expect(result.data).toEqual(wire);
      seen.add(event.type);
    }
    // A six-player match exercises the whole vocabulary except the ones that need luck.
    expect([...seen].sort()).toEqual(
      expect.arrayContaining([
        'bidMade',
        'diceRevealed',
        'dieLost',
        'dudoCalled',
        'matchEnded',
        'matchStarted',
        'playerEliminated',
        'roundStarted',
      ]),
    );
  });

  test('every face 1..6 is accepted and nothing else is', () => {
    for (const face of [1, 2, 3, 4, 5, 6]) expect(FaceSchema.safeParse(face).success).toBe(true);
    for (const bad of [0, 7, 1.5, -1, '3', null]) {
      expect(FaceSchema.safeParse(bad).success).toBe(false);
    }
  });

  test('a view with a foreign hand bolted on is rejected, not quietly carried', () => {
    const opened = createMatch(
      { matchId: 'M', playerIds: ['a', 'b'] },
      { now: 0, rng: makeRng(1) },
    );
    if (!opened.ok) throw new Error(opened.reason);
    const view = redactFor(opened.value.state, 'a');
    const tampered = { ...view, round: { ...view.round, hands: { b: [1, 2, 3] } } };
    // Strict objects: an unexpected key is an error rather than something that survives to
    // a client. This is the schema half of the redaction guarantee.
    expect(PlayerViewSchema.safeParse(tampered).success).toBe(false);
  });

  test('the reason-code enum and the engine agree at runtime too', () => {
    // Provoke a rejection and check the code is one the protocol can carry.
    const opened = createMatch(
      { matchId: 'M', playerIds: ['a', 'b'] },
      { now: 0, rng: makeRng(1) },
    );
    if (!opened.ok) throw new Error(opened.reason);
    const rejected = reduce(
      opened.value.state,
      { type: 'bid', playerId: 'b', bid: { quantity: 1, face: 2 } },
      { now: 1, rng: makeRng(1) },
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(EngineErrorReasonSchema.safeParse(rejected.reason).success).toBe(true);
  });
});
