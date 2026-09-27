/** Building states: R-01 to R-03 at setup, and the same roll at every later round. */
import type {
  Ctx,
  Face,
  GameState,
  MatchConfig,
  PlayerId,
  PlayerState,
  Result,
  Transition,
} from './types.ts';
import { err, FACES, ok } from './types.ts';

export const DEFAULT_CONFIG: MatchConfig = { startingDice: 5, maxDice: 5 };

/** R-01: 2 to 6. v1 matchmaking targets 4, but the engine must not care. */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

export interface MatchSetup {
  readonly matchId: string;
  /** Seat order, clockwise (R-05). The matchmaker decides it; the engine keeps it fixed. */
  readonly playerIds: readonly PlayerId[];
  readonly config?: MatchConfig;
}

/**
 * R-02: one six-sided die. Indexing FACES rather than casting a number keeps the Face
 * union honest, and the clamp means a caller whose generator returns exactly 1.0 cannot
 * produce a seventh face.
 */
const rollDie = (rng: () => number): Face => FACES[Math.min(5, Math.floor(rng() * 6))] ?? 1;

/**
 * R-03: every remaining player's dice are rolled secretly. Eliminated players get no
 * entry at all, which is what keeps `countFace` honest — there is nothing to exclude.
 * Seat order is walked in order so that a seed reproduces a deal exactly.
 */
export function rollHands(
  players: readonly PlayerState[],
  rng: () => number,
): Record<PlayerId, readonly Face[]> {
  const hands: Record<PlayerId, readonly Face[]> = {};
  for (const player of players) {
    if (player.diceCount <= 0) continue;
    hands[player.id] = Array.from({ length: player.diceCount }, () => rollDie(rng));
  }
  return hands;
}

/**
 * Seat the players, deal round 0, and put the first seat on turn.
 *
 * R-05 fixes the seat order but says nothing about who opens the very first round; seat 0
 * is as good an answer as any, and the matchmaker controls the seating anyway.
 */
export function createMatch(setup: MatchSetup, ctx: Ctx): Result<Transition> {
  const { matchId, playerIds } = setup;
  if (playerIds.length < MIN_PLAYERS || playerIds.length > MAX_PLAYERS) {
    return err('INVALID_PLAYER_COUNT');
  }
  if (new Set(playerIds).size !== playerIds.length) return err('DUPLICATE_PLAYER_ID');

  const config = setup.config ?? DEFAULT_CONFIG;
  const players: readonly PlayerState[] = playerIds.map((id, seat) => ({
    id,
    seat,
    diceCount: config.startingDice,
  }));
  const [firstSeat] = players;
  if (firstSeat === undefined) return err('INVALID_PLAYER_COUNT');
  const starterId = firstSeat.id;
  const hands = rollHands(players, ctx.rng);

  const state: GameState = {
    matchId,
    config,
    players,
    round: { index: 0, starterId, hands, bids: [] },
    phase: { kind: 'bidding', turnId: starterId },
    lastReveal: null,
    seq: 0,
    startedAt: ctx.now,
    endedAt: null,
  };

  return ok({
    state,
    events: [
      { type: 'matchStarted', playerIds, startingDice: config.startingDice },
      {
        type: 'roundStarted',
        index: 0,
        starterId,
        diceCounts: diceCountsOf(players),
      },
    ],
  });
}

export const diceCountsOf = (players: readonly PlayerState[]): Record<PlayerId, number> =>
  Object.fromEntries(players.filter((p) => p.diceCount > 0).map((p) => [p.id, p.diceCount]));
