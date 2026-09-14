/**
 * Seeded PRNG for tests, the CLI, and deterministic replay.
 *
 * R-20 requires the *server* to roll dice with a CSPRNG, so this must never be wired into
 * production: it exists so that a match can be reproduced exactly from a seed, which
 * PLAN.md calls the best debugging tool the project will have.
 *
 * mulberry32 — 32-bit state, one multiply-and-xorshift round per call. Fast, decent
 * distribution, not cryptographic.
 */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
