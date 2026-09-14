import { expect } from 'vitest';
import type {
  Action,
  Bid,
  BidRecord,
  Ctx,
  ErrorReason,
  Face,
  GameEvent,
  GameState,
  MatchConfig,
  Phase,
  PlayerId,
  Result,
} from '../src/types.ts';
import { createMatch, legalBids, reduce } from '../src/index.ts';
import { makeRng } from '../src/rng.ts';

export const TEST_CONFIG: MatchConfig = { startingDice: 5, maxDice: 5 };

export const bid = (quantity: number, face: Face): Bid => ({ quantity, face });

export const ctx = (seed = 1, now = 1_000): Ctx => ({ now, rng: makeRng(seed) });

/** Unwrap a Result, failing the test with the reason code if it is an error. */
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) expect.unreachable(`expected ok, got error: ${result.reason}`);
  return result.value;
}

export function expectErr<T>(result: Result<T>, reason: ErrorReason): void {
  expect(result.ok, `expected error ${reason}, got ok`).toBe(false);
  if (!result.ok) expect(result.reason).toBe(reason);
}

/**
 * Build a GameState directly, so a rule can be tested against an exact set of hands
 * rather than whatever the dice happened to do. Seats are assigned in `hands` key order.
 *
 * `GameState` is plain data with no invariants enforced by a constructor, which is
 * precisely what makes this possible — one of the quieter benefits of a pure reducer.
 */
export function makeState(spec: {
  hands: Record<PlayerId, readonly Face[]>;
  /** Owned dice. Defaults to each player's hand length. */
  diceCounts?: Record<PlayerId, number>;
  bids?: readonly BidRecord[];
  /** Defaults to the round starter. */
  turnId?: PlayerId;
  palifico?: boolean;
  /** Defaults to the first seat. */
  starterId?: PlayerId;
  palificoUsed?: readonly PlayerId[];
  palificoNextFor?: PlayerId | null;
  phase?: Phase;
  roundIndex?: number;
  config?: MatchConfig;
}): GameState {
  const ids = Object.keys(spec.hands);
  const starterId = spec.starterId ?? ids[0]!;
  const palificoUsed = spec.palificoUsed ?? [];
  return {
    matchId: 'M',
    config: spec.config ?? TEST_CONFIG,
    players: ids.map((id, seat) => ({
      id,
      seat,
      diceCount: spec.diceCounts?.[id] ?? spec.hands[id]!.length,
      palificoUsed: palificoUsed.includes(id),
    })),
    round: {
      index: spec.roundIndex ?? 0,
      palifico: spec.palifico ?? false,
      starterId,
      hands: spec.hands,
      bids: spec.bids ?? [],
    },
    phase: spec.phase ?? { kind: 'bidding', turnId: spec.turnId ?? starterId },
    lastReveal: null,
    palificoNextFor: spec.palificoNextFor ?? null,
    seq: 0,
    startedAt: 0,
    endedAt: null,
  };
}

/** A four-player state with every hand given explicitly. */
export function fourPlayers(
  hands: [readonly Face[], readonly Face[], readonly Face[], readonly Face[]],
  rest: Omit<Parameters<typeof makeState>[0], 'hands'> = {},
): GameState {
  return makeState({ hands: { a: hands[0], b: hands[1], c: hands[2], d: hands[3] }, ...rest });
}

/**
 * Drive a whole match with random-but-legal play. Used by the property tests and the
 * redaction sweep. The bot policy lives here rather than in `src` because it is strategy,
 * not rules — Phase 5's `packages/bots` is where a real one will go.
 */
export function playRandomMatch(opts: {
  seed: number;
  playerIds: readonly PlayerId[];
  /** Chance of calling dudo when a bid is standing. */
  challengeChance?: number;
  maxSteps?: number;
}): {
  readonly final: GameState;
  readonly actions: readonly Action[];
  readonly states: readonly GameState[];
  readonly events: readonly GameEvent[];
  readonly steps: number;
} {
  const challengeChance = opts.challengeChance ?? 0.25;
  const maxSteps = opts.maxSteps ?? 20_000;
  // Two independent streams, so that changing the bot policy does not change the dice.
  const rng = makeRng(opts.seed);
  const botRng = makeRng((opts.seed ^ 0x9e37_79b9) >>> 0);

  const opened = unwrap(createMatch({ matchId: 'M', playerIds: opts.playerIds }, { now: 0, rng }));
  let state = opened.state;
  const actions: Action[] = [];
  const states: GameState[] = [state];
  const events: GameEvent[] = [...opened.events];
  let steps = 0;

  while (state.phase.kind !== 'ended' && steps < maxSteps) {
    steps += 1;
    const action = randomLegalAction(state, botRng, challengeChance);
    const result = reduce(state, action, { now: steps, rng });
    if (!result.ok) expect.unreachable(`random play produced an illegal action: ${result.reason}`);
    actions.push(action);
    state = result.value.state;
    states.push(state);
    events.push(...result.value.events);
  }

  return { final: state, actions, states, events, steps };
}

/** A legal action for whoever is on turn: advance a reveal, else bid or challenge. */
export function randomLegalAction(
  state: GameState,
  rng: () => number,
  challengeChance = 0.25,
): Action {
  if (state.phase.kind !== 'bidding') return { type: 'advanceRound' };
  const playerId = state.phase.turnId;
  const options = legalBids(state);
  const mustBid = state.round.bids.length === 0; // R-06
  if (options.length === 0) return { type: 'dudo' as const, playerId }; // R-09's dead end
  if (!mustBid && rng() < challengeChance) return { type: 'dudo', playerId };
  // Weight the low end of the ladder: bidding near the top would end every round at once.
  const index = Math.floor(rng() ** 2 * options.length);
  return { type: 'bid', playerId, bid: options[Math.min(index, options.length - 1)]! };
}

/**
 * Re-run an action list from scratch with the same seed. `playRandomMatch` feeds
 * `now: steps` to each call, so replay must do the same — the clock is part of the input.
 */
export function replayActions(
  seed: number,
  playerIds: readonly PlayerId[],
  actions: readonly Action[],
): GameState {
  const rng = makeRng(seed);
  let state = unwrap(createMatch({ matchId: 'M', playerIds }, { now: 0, rng })).state;
  actions.forEach((action, i) => {
    state = unwrap(reduce(state, action, { now: i + 1, rng })).state;
  });
  return state;
}
