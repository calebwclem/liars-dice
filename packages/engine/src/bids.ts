/**
 * R-04 through R-09: what counts, and what counts as a raise.
 *
 * R-08 is one comparison. Order bids by `[quantity, face]` and a raise is legal exactly when
 * the new pair is lexicographically greater than the standing one:
 *
 *   higher quantity, any face   [q',f'] > [q,f] whenever q' > q
 *   same quantity, higher face  ties on quantity, the higher face wins
 *   anything else               not a raise
 *
 * R-09 says ones have no special standing in bidding, so there is nothing further to encode:
 * face 1 is simply the lowest face. Ones remain wild for *counting* (R-07) — that is
 * `countFace`'s business, below, and it is the one place the two rules pull apart.
 *
 * An earlier ruleset gave ones a halved quantity to switch to and a doubled one to leave,
 * which needed ones ranked at `[2q, 7]`. It was removed deliberately; see docs/DECISIONS.md.
 */
import type { Bid, Face, GameState, PlayerId, PlayerView, Result } from './types.ts';
import { err, FACES, ok } from './types.ts';
import { lockedFace, standingBid, totalDiceInPlay } from './query.ts';

export const isFace = (value: number): value is Face =>
  Number.isInteger(value) && value >= 1 && value <= 6;

/**
 * Everything the raise rules actually consult. Pulled out as its own type because a
 * client holds a `PlayerView`, never a `GameState`, and CLAUDE.md lets a client grey out
 * an illegal button — which it can only do if it can ask the question. Both shapes can
 * produce a context, so the rule is implemented once and answers both.
 */
/** The cheapest legal quantity for one face, or null if that face cannot be bid at all. */
export interface BidOption {
  readonly face: Face;
  readonly minQuantity: number | null;
}

export interface BidContext {
  /** The bid on the table, or null if the round has not been opened (R-05). */
  readonly standing: Bid | null;
  /** R-13: the face the opening bid of a palifico round locked; null otherwise. */
  readonly lockedFace: Face | null;
  /** R-07 / R-13: false means ones are wild. */
  readonly palifico: boolean;
  /** R-04: the ceiling on a legal quantity. */
  readonly diceInPlay: number;
}

export const bidContextOf = (state: GameState): BidContext => ({
  standing: standingBid(state),
  lockedFace: lockedFace(state),
  palifico: state.round.palifico,
  diceInPlay: totalDiceInPlay(state),
});

export const bidContextOfView = (view: PlayerView): BidContext => ({
  standing: view.round.bids.at(-1)?.bid ?? null,
  lockedFace: view.round.lockedFace,
  palifico: view.round.palifico,
  diceInPlay: view.totalDiceInPlay,
});

/**
 * R-04: how many dice on the table show `face`. R-07: a 1 counts as any face when ones
 * are wild — but a bid *on* ones counts only the ones themselves, never double.
 */
export function countFace(
  hands: Readonly<Record<PlayerId, readonly Face[]>>,
  face: Face,
  wildOnes: boolean,
): number {
  const wild = wildOnes && face !== 1;
  let count = 0;
  for (const hand of Object.values(hands)) {
    for (const die of hand) {
      if (die === face || (wild && die === 1)) count += 1;
    }
  }
  return count;
}

export const bidKey = (bid: Bid): readonly [number, number] => [bid.quantity, bid.face];

/** Negative if `a` is the weaker bid, positive if stronger, 0 if they are the same bid. */
export function compareBids(a: Bid, b: Bid): number {
  return a.quantity !== b.quantity ? a.quantity - b.quantity : a.face - b.face;
}

/** R-08: is `next` a legal raise over `prev`? */
export const isRaise = (prev: Bid, next: Bid): boolean => compareBids(prev, next) < 0;

/**
 * Every reason a bid can be rejected, in the order a player would care about: malformed
 * first, then out of range (R-04), then out of order (R-08/R-09/R-13).
 */
export function checkBidIn(ctx: BidContext, next: Bid): Result<true> {
  if (!Number.isInteger(next.quantity) || next.quantity < 1) return err('BID_QUANTITY_INVALID');
  if (!isFace(next.face)) return err('BID_FACE_INVALID');
  if (next.quantity > ctx.diceInPlay) return err('BID_EXCEEDS_DICE_IN_PLAY');

  const { standing } = ctx;
  if (standing === null) return ok(true); // R-05: an opening bid has nothing to clear.

  if (ctx.lockedFace !== null && next.face !== ctx.lockedFace) {
    return err('PALIFICO_FACE_LOCKED'); // R-13
  }
  if (!isRaise(standing, next)) return err('BID_TOO_LOW');
  return ok(true);
}

export const checkBid = (state: GameState, next: Bid): Result<true> =>
  checkBidIn(bidContextOf(state), next);

/** Convenience for clients deciding whether to enable a button. The server re-validates. */
export const isLegalBid = (state: GameState, bid: Bid): boolean => checkBid(state, bid).ok;

/**
 * Every bid the player on turn could legally make, weakest first. Bounded by R-04's cap,
 * so this is at most `6 * totalDiceInPlay` candidates — 180 in a full six-player match.
 */
export function legalBidsIn(ctx: BidContext): readonly Bid[] {
  const out: Bid[] = [];
  for (let quantity = 1; quantity <= ctx.diceInPlay; quantity += 1) {
    for (const face of FACES) {
      const candidate: Bid = { quantity, face };
      if (checkBidIn(ctx, candidate).ok) out.push(candidate);
    }
  }
  return out.sort((a, b) => compareBids(a, b));
}

export const legalBids = (state: GameState): readonly Bid[] => legalBidsIn(bidContextOf(state));

/**
 * The weakest legal bid, or null when the ladder has run out — which happens only on a
 * maximal ones bid, where R-09 would demand more dice than exist (see R-09's last
 * bullet). The player must then challenge. Phase 2's R-17 timeout auto-bid calls this.
 */
export const minimumLegalBidIn = (ctx: BidContext): Bid | null => legalBidsIn(ctx)[0] ?? null;

/**
 * The cheapest legal quantity for each face, or null where that face has none.
 *
 * This exists so a client can grey out an impossible button without containing a single rule.
 * For any fixed face the legal quantities are a contiguous run — everything from a threshold
 * up to R-04's dice-in-play cap — so six numbers describe the entire legal set exactly. A
 * property test asserts that contiguity, because the client's UI depends on it being true and
 * it is a consequence of the comparator rather than something stated in docs/RULES.md.
 *
 * Sending this rather than the whole legal set keeps a snapshot small: six entries instead of
 * up to 180 bids.
 */
export function bidOptionsIn(ctx: BidContext): readonly BidOption[] {
  return FACES.map((face) => {
    for (let quantity = 1; quantity <= ctx.diceInPlay; quantity += 1) {
      if (checkBidIn(ctx, { quantity, face }).ok) return { face, minQuantity: quantity };
    }
    return { face, minQuantity: null };
  });
}

export const bidOptionsOf = (state: GameState): readonly BidOption[] =>
  bidOptionsIn(bidContextOf(state));

export const minimumLegalBid = (state: GameState): Bid | null =>
  minimumLegalBidIn(bidContextOf(state));
