/**
 * Bot policies.
 *
 * Pure, and deliberately blind: `decide` takes a `PlayerView` — the same redacted snapshot a person
 * gets — so a bot physically cannot see another player's dice. It returns an `Action` for the
 * server to validate like any other, because a bot is a player, not an authority.
 *
 * Used for matchmaking backfill and R-17/R-18 seat takeover today, and for the web client's offline
 * practice mode in Phase 8, which can import this directly.
 */
export { decide } from './policy.ts';
export type { BotProfile, DecideOptions, Judgement } from './policy.ts';
export { BALANCED, BOLD, CAUTIOUS, PROFILES, profileFor } from './profiles.ts';
export { atLeast, expected, matchChance } from './probability.ts';
