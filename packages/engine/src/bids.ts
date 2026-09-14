/**
 * R-04 through R-09: what counts, and what counts as a raise.
 *
 * The whole of R-08 and R-09 reduces to one comparison. Map every bid to a two-part key
 *
 *     key(q, f) = wildOnes && f === 1  ?  [2q, 7]  :  [q, f]
 *
 * and a raise is legal exactly when the new key is lexicographically greater than the
 * standing one. Ones sit at twice their quantity because a wild one is worth two of
 * anything else (R-07), and at face rank 7 because a ones bid beats every ordinary bid
 * that ties it on quantity.
 *
 * That single rule reproduces the document line for line:
 *
 *   R-08  (q,f) -> (q',f') with q' > q, any face      [q',f'] > [q,f] whenever q' > q
 *         (q,f) -> (q,f')  with f' > f                ties on quantity, higher face wins
 *   R-09  onto ones: q' >= ceil(q/2)                  2q' > q  <=>  q' >= ceil(q/2)
 *         off ones:  q' >= 2q + 1                     q' > 2q, since f' <= 6 < 7
 *         ones over ones: q' > q                      2q' > 2q
 *
 * During a palifico round `wildOnes` is false (R-13), so ones lose their special rank and
 * the key is simply [q, f] for every face — and since R-13 also locks the face, what is
 * left is a plain quantity ladder.
 */
import type { Bid, Face, GameState, PlayerId, PlayerView, Result } from './types.ts';
import { err, FACES, ok } from './types.ts';
import { lockedFace, standingBid, totalDiceInPlay } from './query.ts';

/** Rank given to face 1 when ones are wild: above every real face. */
const ONES_RANK = 7;

export const isFace = (value: number): value is Face =>
  Number.isInteger(value) && value >= 1 && value <= 6;

/**
 * Everything the raise rules actually consult. Pulled out as its own type because a
 * client holds a `PlayerView`, never a `GameState`, and CLAUDE.md lets a client grey out
 * an illegal button — which it can only do if it can ask the question. Both shapes can
 * produce a context, so the rule is implemented once and answers both.
 */
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

export const bidKey = (bid: Bid, wildOnes: boolean): readonly [number, number] =>
  wildOnes && bid.face === 1 ? [bid.quantity * 2, ONES_RANK] : [bid.quantity, bid.face];

/** Negative if `a` is the weaker bid, positive if stronger, 0 if they are the same bid. */
export function compareBids(a: Bid, b: Bid, wildOnes: boolean): number {
  const [aq, af] = bidKey(a, wildOnes);
  const [bq, bf] = bidKey(b, wildOnes);
  return aq !== bq ? aq - bq : af - bf;
}

/** R-08 / R-09: is `next` a legal raise over `prev`? */
export const isRaise = (prev: Bid, next: Bid, wildOnes: boolean): boolean =>
  compareBids(prev, next, wildOnes) < 0;

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
  if (!isRaise(standing, next, !ctx.palifico)) return err('BID_TOO_LOW');
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
  const wildOnes = !ctx.palifico;
  const out: Bid[] = [];
  for (let quantity = 1; quantity <= ctx.diceInPlay; quantity += 1) {
    for (const face of FACES) {
      const candidate: Bid = { quantity, face };
      if (checkBidIn(ctx, candidate).ok) out.push(candidate);
    }
  }
  return out.sort((a, b) => compareBids(a, b, wildOnes));
}

export const legalBids = (state: GameState): readonly Bid[] => legalBidsIn(bidContextOf(state));

/**
 * The weakest legal bid, or null when the ladder has run out — which happens only on a
 * maximal ones bid, where R-09 would demand more dice than exist (see R-09's last
 * bullet). The player must then challenge. Phase 2's R-17 timeout auto-bid calls this.
 */
export const minimumLegalBidIn = (ctx: BidContext): Bid | null => legalBidsIn(ctx)[0] ?? null;

export const minimumLegalBid = (state: GameState): Bid | null =>
  minimumLegalBidIn(bidContextOf(state));
