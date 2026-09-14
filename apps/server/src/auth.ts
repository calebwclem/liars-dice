/**
 * Guest identity, stateless.
 *
 * PLAN.md wants anonymous device accounts first so there is no onboarding friction, with
 * Sign in with Apple arriving at Phase 6. A token here is just `playerId.expiry.hmac`,
 * signed with `AUTH_SECRET`: the server can verify who someone is without a database,
 * which is the whole reason Phase 2 needs no Postgres.
 *
 * What this is not: a session store. There is no revocation and no refresh. Both arrive
 * with real accounts, when there is somewhere to record them.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Clock } from './clock.ts';

export type PlayerId = string;

export interface Identity {
  readonly playerId: PlayerId;
  readonly token: string;
  /** True when this connect minted a new guest rather than resuming one. */
  readonly fresh: boolean;
}

export type VerifyFailure = 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED';

export interface Auth {
  issue(playerId?: PlayerId): Identity;
  /** Accepts a token and returns the identity, or a reason it was refused. */
  resume(token: string): Identity | VerifyFailure;
  /** `resume` if the token is good, a brand new guest otherwise. */
  authenticate(token: string | undefined): Identity;
}

const sign = (secret: string, payload: string): string =>
  createHmac('sha256', secret).update(payload).digest('base64url');

/** Constant-time compare; a length mismatch is a mismatch without leaking where. */
const sameSignature = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
};

export function createAuth(options: {
  secret: string;
  ttlMs: number;
  clock: Clock;
  newPlayerId?: () => PlayerId;
}): Auth {
  const { secret, ttlMs, clock } = options;
  const newPlayerId = options.newPlayerId ?? (() => `g_${randomUUID()}`);

  const issue = (playerId: PlayerId = newPlayerId()): Identity => {
    const expiry = clock.now() + ttlMs;
    const payload = `${playerId}.${String(expiry)}`;
    return { playerId, token: `${payload}.${sign(secret, payload)}`, fresh: true };
  };

  const resume = (token: string): Identity | VerifyFailure => {
    const parts = token.split('.');
    if (parts.length !== 3) return 'MALFORMED';
    const [playerId, expiryText, signature] = parts;
    if (playerId === undefined || expiryText === undefined || signature === undefined) {
      return 'MALFORMED';
    }
    if (playerId === '' || !/^\d+$/.test(expiryText)) return 'MALFORMED';
    if (!sameSignature(sign(secret, `${playerId}.${expiryText}`), signature)) {
      return 'BAD_SIGNATURE';
    }
    if (Number(expiryText) <= clock.now()) return 'EXPIRED';
    return { playerId, token, fresh: false };
  };

  return {
    issue,
    resume,
    authenticate(token) {
      if (token === undefined) return issue();
      const resumed = resume(token);
      // An unusable token is not an error a guest can act on: mint a new identity and let
      // them play. The old one is unrecoverable either way.
      return typeof resumed === 'string' ? issue() : resumed;
    },
  };
}
