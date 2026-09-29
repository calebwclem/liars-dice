/**
 * Configuration. Everything comes from the environment (CLAUDE.md: no secrets in the
 * repo), is validated once at boot, and is then a plain frozen object — so a missing or
 * malformed variable is a startup failure with a readable message rather than an
 * `undefined` that surfaces three hours into a match.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Read `apps/server/.env` into the environment, if there is one.
 *
 * This used to be `--env-file-if-exists=.env` on the `dev` script, which worked but printed
 * `.env not found. Continuing without it.` *twice* on every start: `node --watch` runs a
 * supervisor and a child, and both of them parse the flag even though only the child ever runs
 * the server. Two identical notices above one `server.listening` reads like two servers came up.
 *
 * Doing it here instead means the process that actually serves is the one that reads the file,
 * once, quietly. The semantics are the flag's: a real environment variable always wins over the
 * file, and a missing file is not an error — a server configured entirely from the environment,
 * which is how it runs in production, has no `.env` at all.
 *
 * Resolved against this module rather than the working directory, so it does not matter whether
 * the server was started from the repo root or from `apps/server`.
 */
export function loadEnvFile(path = join(import.meta.dirname, '..', '.env')): void {
  try {
    process.loadEnvFile(path);
  } catch {
    /* no .env; the environment is the configuration */
  }
}

const ms = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(8080),
  HOST: z.string().min(1).default('0.0.0.0'),

  /** Signs guest tokens. Required in production; see the boot check below. */
  AUTH_SECRET: z.string().min(16).optional(),
  TOKEN_TTL_MS: ms(30 * 24 * 60 * 60 * 1_000),

  /** R-16: 30 seconds. R-18: 45 seconds. Both are rules; do not tune them casually. */
  TURN_MS: ms(30_000),
  RECONNECT_GRACE_MS: ms(45_000),

  /** Pacing, not rules. How long clients get to show a reveal, and bot think time. */
  REVEAL_MS: ms(3_500),
  BOT_THINK_MS: ms(700),

  /**
   * Rate limit per connection: a token bucket of RATE_LIMIT_BURST, refilled at
   * RATE_LIMIT_PER_SECOND. A turn-based game sends roughly one message per turn, so the
   * defaults sit orders of magnitude above legitimate play.
   */
  RATE_LIMIT_BURST: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_PER_SECOND: z.coerce.number().int().positive().default(5),

  /** PLAN.md: fill to MATCH_SIZE, or backfill with bots after QUEUE_BACKFILL_MS. */
  MATCH_SIZE: z.coerce.number().int().min(2).max(6).default(4),
  QUEUE_BACKFILL_MS: ms(10_000),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
});

export type Config = Readonly<z.infer<typeof EnvSchema>> & { readonly AUTH_SECRET: string };

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`invalid configuration:\n${problems}`);
  }

  const config = parsed.data;
  if (config.AUTH_SECRET === undefined) {
    if (config.NODE_ENV === 'production') {
      throw new Error('AUTH_SECRET is required in production — see apps/server/.env.example');
    }
    // Development convenience: a throwaway secret, which means guest tokens stop working
    // when the process restarts. Fine locally, never acceptable in production.
    return Object.freeze({ ...config, AUTH_SECRET: randomBytes(32).toString('hex') });
  }
  return Object.freeze({ ...config, AUTH_SECRET: config.AUTH_SECRET });
}
