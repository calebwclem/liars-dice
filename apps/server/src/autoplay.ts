/**
 * What the server plays when a human does not.
 *
 * Two distinct policies, because R-17 asks for two distinct things:
 *
 *   `timeoutAction` — R-17's auto-bid: the minimum legal raise, exactly as specified. Used
 *   once when a turn times out and the player is still in control of their seat.
 *
 *   `botAction` — what a bot-controlled seat plays for the rest of the match, after R-17's
 *   second consecutive timeout or R-18's lapsed reconnect grace. A random legal action with
 *   a fixed challenge rate: witless, but it moves the game along, whereas always playing
 *   the minimum raise would walk every round up the entire ladder.
 *
 * Both are placeholders for `packages/bots` (Phase 5), which will take a redacted view and
 * compute binomial expectations. Neither looks at any player's dice — they read only the
 * bid context, which is all a real bot policy is allowed to see anyway.
 */
import type { Action, BidContext, GameState } from '@liars-dice/engine';
import { bidContextOf, legalBidsIn, minimumLegalBidIn } from '@liars-dice/engine';

/** R-06: the round's opening player must bid, so a challenge is not an option there. */
const mustBid = (state: GameState): boolean => state.round.bids.length === 0;

/**
 * R-17: "the server plays the minimum legal raise for that player". When no legal raise
 * exists — a maximal ones bid, R-09's dead end — there is nothing to raise to, so the only
 * move left is dudo.
 */
export function timeoutAction(state: GameState, playerId: string): Action {
  const context: BidContext = bidContextOf(state);
  const bid = minimumLegalBidIn(context);
  if (bid === null) return { type: 'dudo', playerId };
  return { type: 'bid', playerId, bid };
}

export const CHALLENGE_RATE = 0.22;

export function botAction(state: GameState, playerId: string, rng: () => number): Action {
  const context = bidContextOf(state);
  const options = legalBidsIn(context);
  if (options.length === 0) return { type: 'dudo', playerId };
  if (!mustBid(state) && rng() < CHALLENGE_RATE) return { type: 'dudo', playerId };
  // Skewed toward the weakest raises: sampling the ladder uniformly would open every round
  // near the dice-in-play cap, which is legal but makes for a pointless game.
  const window = Math.min(options.length, 10);
  const index = Math.min(Math.floor(rng() ** 3 * window), options.length - 1);
  const chosen = options[index];
  if (chosen === undefined) return { type: 'dudo', playerId };
  return { type: 'bid', playerId, bid: chosen };
}
