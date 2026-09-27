/**
 * The bot's judgement.
 *
 * It sees exactly what a person sees — a `PlayerView`, its own hand and nothing else — and returns
 * an `Action`. That signature is the whole point: a bot that took a `GameState` could read the
 * table, and no amount of good intentions in the body would make it fair. CLAUDE.md puts it as
 * "pure; take a redacted view, return an action", and the type enforces it.
 *
 * No rules live here either. Which bids are legal comes from the engine (`legalBidsIn`), so the bot
 * cannot invent a move the server would refuse, or fall out of step when a rule changes.
 *
 * The decision is one comparison. On your turn there are exactly two things you can do, so the
 * question is never "is this bid good enough" in the abstract — it is "am I more likely to survive
 * a raise than to win a challenge". An earlier version of this file asked those two questions
 * separately, with a threshold each, and the result was a bot that opened at the very edge of what
 * it could believe and got called on it immediately, every round.
 */
import type { Action, Bid, PlayerView } from '@liars-dice/engine';
import { bidContextOfView, compareBids, legalBidsIn } from '@liars-dice/engine';
import { atLeast, matchChance } from './probability.ts';

export interface BotProfile {
  readonly name: string;
  /**
   * How sure it insists on being when opening a round. It then opens with the *boldest* bid that
   * clears this bar, which lands near what the table can be expected to hold — lower opens bolder.
   *
   * A floor rather than a target: aiming at a confidence picks whichever bid happens to sit nearest
   * it, and "one one" is about 60% likely on a full table. Technically on target, strategically
   * worthless.
   */
  readonly openConfidence: number;
  /**
   * How much it prefers raising to challenging. 1 weighs them evenly; below 1 reaches for dudo
   * sooner, above 1 keeps the bidding going.
   */
  readonly aggression: number;
  /**
   * How often it raises on something it does not believe. Without this a bot is readable: every
   * bid it makes would be one it can back, so challenging it is never right and playing against it
   * teaches you nothing.
   */
  readonly bluff: number;
}

/** What the bot thought, for logs and for tests that care about the reasoning. */
export interface Judgement {
  readonly action: Action;
  /** The chance the standing bid is true, or null when opening the round. */
  readonly standingChance: number | null;
  /** The chance the bid it chose is true, or null when it challenged. */
  readonly chosenChance: number | null;
  readonly bluffed: boolean;
  readonly reason:
    'opening' | 'raise-beats-challenge' | 'bluff' | 'challenge-beats-raise' | 'no-raise-possible';
}

export interface DecideOptions {
  readonly profile: BotProfile;
  /** Uniform in [0, 1). Injected, so a bot's choices replay exactly like everything else. */
  readonly rng: () => number;
}

/**
 * Decide what to do, or null if there is nothing to decide — not this bot's turn, no seat, or the
 * match is not in the bidding phase.
 */
export function decide(view: PlayerView, options: DecideOptions): Judgement | null {
  const me = view.you;
  if (me === null) return null;
  if (view.phase.kind !== 'bidding' || view.phase.turnId !== me.id) return null;

  const playerId = me.id;
  const context = bidContextOfView(view);
  const raises = legalBidsIn(context);
  const unseen = Math.max(0, view.totalDiceInPlay - me.dice.length);

  /** The chance a bid is true, given this hand and that many unseen dice. */
  const chance = (bid: Bid): number => {
    // R-07: a one in hand backs any face but ones themselves.
    const mine = me.dice.filter((die) => die === bid.face || (bid.face !== 1 && die === 1)).length;
    return atLeast(unseen, matchChance(bid.face), bid.quantity - mine);
  };

  const { standing } = context;
  const bluffing = options.rng() < options.profile.bluff;

  // R-04's ceiling: at the cap on sixes there is no legal raise at all, so there is nothing to
  // decide. R-06 guarantees this cannot happen to the player opening a round.
  if (raises.length === 0) {
    return {
      action: { type: 'dudo', playerId },
      standingChance: standing === null ? null : chance(standing),
      chosenChance: null,
      bluffed: false,
      reason: 'no-raise-possible',
    };
  }

  const scored = raises.map((bid) => ({ bid, chance: chance(bid) }));

  // R-06: the round's first player must bid. Aim for a bid of a given confidence rather than the
  // boldest believable one — opening at the edge of plausibility is both readable and easy to call.
  if (standing === null) {
    const floor = bluffing ? options.profile.openConfidence * 0.7 : options.profile.openConfidence;
    const opening = boldest(scored, floor) ?? mostLikely(scored);
    return {
      action: { type: 'bid', playerId, bid: opening.bid },
      standingChance: null,
      chosenChance: opening.chance,
      bluffed: bluffing,
      reason: 'opening',
    };
  }

  const standingChance = chance(standing);
  // What each move is worth. Challenging wins exactly when the bid is false; raising survives when
  // the new bid is true. Neither is the whole story — what happens next round matters too — but it
  // is the comparison a person actually makes at the table.
  const challengeValue = 1 - standingChance;
  const best = mostLikely(scored);
  const raiseValue = best.chance * options.profile.aggression;

  // Never bluff past an obvious lie: if the standing bid is almost certainly false, calling it is
  // free and raising over it just hands the round back.
  const worthBluffing = standingChance > 0.15;

  if (bluffing && worthBluffing && raiseValue < challengeValue) {
    // The honest read says challenge; bluff by raising anyway.
    //
    // The bluff is the *decision to raise*, not the choice of bid — so it still takes the likeliest
    // raise available rather than the cheapest. They usually coincide now that R-09 is gone, but
    // not over a bid on ones: the weakest raise there is one more one, and ones are the one face a
    // wild one does not help. A bluff has to be plausible or it is just a gift.
    return {
      action: { type: 'bid', playerId, bid: best.bid },
      standingChance,
      chosenChance: best.chance,
      bluffed: true,
      reason: 'bluff',
    };
  }

  if (raiseValue >= challengeValue) {
    return {
      action: { type: 'bid', playerId, bid: best.bid },
      standingChance,
      chosenChance: best.chance,
      bluffed: false,
      reason: 'raise-beats-challenge',
    };
  }

  return {
    action: { type: 'dudo', playerId },
    standingChance,
    chosenChance: null,
    bluffed: false,
    reason: 'challenge-beats-raise',
  };
}

interface Scored {
  readonly bid: Bid;
  readonly chance: number;
}

/**
 * The likeliest raise available, breaking ties toward the weakest bid.
 *
 * With R-09 gone this is very nearly always the weakest raise, since asking for more of a face is
 * strictly less likely. It is still computed rather than assumed: the weakest raise by the bid
 * ordering can be a *ones* bid, which counts only ones and so is less likely than the same
 * quantity of the next face up.
 */
function mostLikely(scored: readonly Scored[]): Scored {
  let best = scored[0];
  if (best === undefined) throw new Error('no raises to choose from');
  for (const candidate of scored) {
    if (candidate.chance > best.chance) {
      best = candidate;
    } else if (candidate.chance === best.chance && compareBids(candidate.bid, best.bid) < 0) {
      best = candidate;
    }
  }
  return best;
}

/** The boldest bid at least `floor` likely, or null if nothing is that safe. */
function boldest(scored: readonly Scored[], floor: number): Scored | null {
  let best: Scored | null = null;
  for (const candidate of scored) {
    if (candidate.chance < floor) continue;
    if (best === null || compareBids(candidate.bid, best.bid) > 0) best = candidate;
  }
  return best;
}
