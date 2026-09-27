/** Read-only questions about a GameState. No rule decisions live here. */
import type { Bid, GameState, PlayerId, PlayerState } from './types.ts';

export const totalDiceInPlay = (state: GameState): number =>
  state.players.reduce((sum, p) => sum + p.diceCount, 0);

export const playerById = (state: GameState, id: PlayerId): PlayerState | null =>
  state.players.find((p) => p.id === id) ?? null;

/** The bid currently on the table, or null if the round has not been opened. */
export const standingBid = (state: GameState): Bid | null => state.round.bids.at(-1)?.bid ?? null;

/** R-12: a player with no dice is out. */
export const isActive = (player: PlayerState): boolean => player.diceCount > 0;

export const activePlayers = (state: GameState): readonly PlayerState[] =>
  state.players.filter(isActive);

/**
 * R-05: the next seat clockwise that is still in the match, starting the search *after*
 * `fromSeat`. Used both to pass the turn and, by R-14, to find an eliminated player's
 * left-hand neighbour — that case works precisely because the eliminated player now has
 * zero dice and so fails `isActive`.
 */
export function nextActiveAfter(state: GameState, fromSeat: number): PlayerState {
  const n = state.players.length;
  for (let step = 1; step <= n; step++) {
    const candidate = state.players[(fromSeat + step) % n];
    if (candidate !== undefined && isActive(candidate)) return candidate;
  }
  // Unreachable: reduce ends the match as soon as one player is left (R-12), so there is
  // always at least one active player while a round is in progress.
  throw new Error('no active players remain');
}
