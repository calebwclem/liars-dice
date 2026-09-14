/**
 * R-20: all dice are rolled server-side using a CSPRNG.
 *
 * The engine takes `rng: () => number` and asks nothing about where the entropy came from,
 * which is the point — the CLI passes a seeded PRNG so a match can be replayed, and the
 * server passes this. 48 bits per draw makes the modulo bias in the engine's `rollDie`
 * vanishingly small.
 *
 * Note the consequence for replay: with a CSPRNG the action list alone no longer
 * reproduces a match, so the rolls have to be recorded to replay one. See DECISIONS.md.
 */
import { randomBytes } from 'node:crypto';

const SCALE = 2 ** 48;

export const cryptoRng = (): (() => number) => () => randomBytes(6).readUIntBE(0, 6) / SCALE;
