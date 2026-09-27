/**
 * Named settings, so a table can be filled with opponents that do not all play alike.
 *
 * The numbers are a starting point rather than a result: they were chosen to be legible — cautious
 * folds early and rarely bluffs, bold believes its own stories — and the honest way to tune them
 * is a tournament between profiles, which `test/tournament.test.ts` sets up.
 */
import type { BotProfile } from './policy.ts';

/** Reaches for dudo sooner than most, opens safely, almost never bluffs. */
export const CAUTIOUS: BotProfile = {
  name: 'cautious',
  openConfidence: 0.7,
  aggression: 0.8,
  bluff: 0.05,
};

/** The default opponent: weighs a raise and a challenge evenly. */
export const BALANCED: BotProfile = {
  name: 'balanced',
  openConfidence: 0.6,
  aggression: 1,
  bluff: 0.12,
};

/** Opens near what the table can actually hold, keeps the bidding going, and bluffs. */
export const BOLD: BotProfile = {
  name: 'bold',
  openConfidence: 0.5,
  aggression: 1.15,
  bluff: 0.18,
};

export const PROFILES: readonly BotProfile[] = [CAUTIOUS, BALANCED, BOLD];

/**
 * A profile chosen from a seat id, so the same seat always plays the same way within a match and
 * a table of bots is not three copies of one opponent.
 */
export function profileFor(seatId: string): BotProfile {
  let hash = 0;
  for (const character of seatId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return PROFILES[hash % PROFILES.length] ?? BALANCED;
}
