/**
 * Liar's Dice rules engine — pure, deterministic, zero runtime dependencies.
 *
 * The whole contract is three functions:
 *
 *   createMatch(setup, ctx)          seat players, deal round 0        (R-01..R-03)
 *   reduce(state, action, ctx)       the rules                         (R-04..R-15)
 *   redactFor(state, playerId)       the only client-facing state      (R-03, R-20)
 *
 * Everything else exported here is a pure query the server, the bots, or a client may
 * reuse rather than re-deriving a rule. docs/RULES.md is the spec; rule IDs appear in the
 * comments and in every test name.
 */
export type {
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
  PlayerState,
  PlayerView,
  PublicPlayer,
  Result,
  RevealSummary,
  RoundState,
  Transition,
} from './types.ts';
export { FACES } from './types.ts';

export { createMatch, DEFAULT_CONFIG, MAX_PLAYERS, MIN_PLAYERS } from './state.ts';
export type { MatchSetup } from './state.ts';
export { reduce } from './reduce.ts';
export { redactFor } from './redact.ts';

export {
  checkBid,
  compareBids,
  countFace,
  isLegalBid,
  legalBids,
  minimumLegalBid,
} from './bids.ts';
export {
  activePlayers,
  lockedFace,
  nextActiveAfter,
  playerById,
  standingBid,
  totalDiceInPlay,
} from './query.ts';
export { makeRng } from './rng.ts';
