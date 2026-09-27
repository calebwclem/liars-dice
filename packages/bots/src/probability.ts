/**
 * How likely is a bid to be true?
 *
 * The whole of a bot's judgement rests on one question: given the dice I can see and the ones I
 * cannot, what are the chances there are really that many of a face out there? The dice I cannot
 * see are independent and identically distributed, so the count among them is binomial, and the
 * bid is true exactly when that count reaches what my own hand does not already cover.
 *
 * No rules live here. R-07 decides whether a one counts as another face; this file is only told
 * the resulting probability that a single unseen die matches.
 */

/**
 * The chance one unseen die matches `face`.
 *
 * R-07: ones are wild, so a die matches if it shows the face *or* a one — two of six. A bid on
 * ones is the one exception, since a one only ever counts as a one. R-13 removes the round that
 * used to suspend all of this, so there is no longer a flag to pass.
 */
export function matchChance(face: number): number {
  return face === 1 ? 1 / 6 : 2 / 6;
}

/**
 * `P(X >= k)` for `X ~ Binomial(n, p)`.
 *
 * Summed from the probability mass function, which is built up by its own recurrence rather than
 * from factorials: `C(30, 15)` is fine in a double but the recurrence stays exact-ish for far
 * longer and cannot overflow on the way.
 */
export function atLeast(n: number, p: number, k: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;

  // pmf(0) = (1 - p)^n, then pmf(i + 1) = pmf(i) * (n - i) / (i + 1) * p / (1 - p).
  const ratio = p / (1 - p);
  let mass = (1 - p) ** n;
  let tail = 0;
  for (let i = 0; i <= n; i += 1) {
    if (i >= k) tail += mass;
    mass = (mass * (n - i) * ratio) / (i + 1);
  }
  // Clamp: the recurrence can drift by a few ulps and a probability above 1 reads as a bug.
  return Math.min(1, Math.max(0, tail));
}

/** The expected number of matching dice among `n` unseen ones. */
export const expected = (n: number, p: number): number => n * p;
