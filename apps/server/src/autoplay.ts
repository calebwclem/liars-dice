/**
 * What the server plays when a human does not.
 *
 * Two distinct policies, because R-17 asks for two distinct things:
 *
 *   `timeoutAction` — R-17's auto-bid: the minimum legal raise, exactly as specified. Played once
 *   when a turn times out while the player still holds their seat. It is not a judgement call; the
 *   rule says what to play, so this plays it.
 *
 *   `botAction` — what a bot-controlled seat plays for the rest of the match, after R-17's second
 *   consecutive timeout, R-18's lapsed reconnect grace, or a matchmaking backfill. This is a real
 *   opponent now: `packages/bots` weighs the odds and bluffs.
 *
 * Note what `botAction` does with the state it is handed: it redacts it first. A bot is a player,
 * not an authority, and the policy's signature only accepts a `PlayerView` — so a seat filled by a
 * bot cannot see the table however this file is edited later.
 */
import type { Action, BidContext, GameState } from '@liars-dice/engine';
import { bidContextOf, minimumLegalBidIn, redactFor } from '@liars-dice/engine';
import { decide, profileFor, type BotProfile } from '@liars-dice/bots';

/**
 * R-17: "the server plays the minimum legal raise for that player". When no legal raise exists — a
 * maximal ones bid, R-09's dead end — there is nothing to raise to, so the only move left is dudo.
 */
export function timeoutAction(state: GameState, playerId: string): Action {
  const context: BidContext = bidContextOf(state);
  const bid = minimumLegalBidIn(context);
  if (bid === null) return { type: 'dudo', playerId };
  return { type: 'bid', playerId, bid };
}

/**
 * A bot's move for a seat it now holds.
 *
 * The seat id picks the profile, so one bot at a table plays cautiously and another rides its
 * bluffs, and the same seat plays the same way all match.
 */
export function botAction(
  state: GameState,
  playerId: string,
  rng: () => number,
  profile: BotProfile = profileFor(playerId),
): Action {
  const judgement = decide(redactFor(state, playerId), { profile, rng });
  // `decide` returns null only when it is not this seat's turn, which the room checks before
  // calling. Falling back to R-17's auto-bid keeps a stuck room impossible.
  return judgement?.action ?? timeoutAction(state, playerId);
}
