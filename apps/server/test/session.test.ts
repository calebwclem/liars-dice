import { describe, expect, test } from 'vitest';
import { MAX_MESSAGE_BYTES, parseClientMessage, PROTOCOL_VERSION } from '@liars-dice/protocol';
import { createAuth } from '../src/auth.ts';
import { loadConfig } from '../src/env.ts';
import { Matchmaker } from '../src/matchmaker.ts';
import { silentLogger } from '../src/logger.ts';
import type { SeatSpec } from '../src/room.ts';
import { fakeClock } from './helpers.ts';

const auth = (ttlMs = 60_000) => {
  const clock = fakeClock();
  return { clock, auth: createAuth({ secret: 'a'.repeat(32), ttlMs, clock }) };
};

describe('Guest identity', () => {
  test('a new guest is issued a player id and a token', () => {
    const { auth: a } = auth();
    const identity = a.authenticate(undefined);
    expect(identity.fresh).toBe(true);
    expect(identity.playerId).toMatch(/^g_/);
    expect(identity.token.startsWith(identity.playerId)).toBe(true);
  });

  test('presenting the token again restores the same identity', () => {
    const { auth: a } = auth();
    const first = a.authenticate(undefined);
    const second = a.authenticate(first.token);
    expect(second.playerId).toBe(first.playerId);
    expect(second.fresh).toBe(false);
  });

  test('a tampered token is refused rather than trusted', () => {
    const { auth: a } = auth();
    const issued = a.issue('g_victim');
    const [playerId, expiry, signature] = issued.token.split('.');

    expect(a.resume(`g_attacker.${expiry!}.${signature!}`)).toBe('BAD_SIGNATURE');
    expect(a.resume(`${playerId!}.99999999999999.${signature!}`)).toBe('BAD_SIGNATURE');
    expect(a.resume(`${playerId!}.${expiry!}.deadbeef`)).toBe('BAD_SIGNATURE');
    expect(a.resume('nonsense')).toBe('MALFORMED');
    expect(a.resume('')).toBe('MALFORMED');
  });

  test('a token signed with a different secret is refused', () => {
    const clock = fakeClock();
    const mint = createAuth({ secret: 'a'.repeat(32), ttlMs: 60_000, clock });
    const other = createAuth({ secret: 'b'.repeat(32), ttlMs: 60_000, clock });
    expect(other.resume(mint.issue().token)).toBe('BAD_SIGNATURE');
  });

  test('an expired token is refused, and authenticate quietly issues a new guest', () => {
    const { auth: a, clock } = auth(1_000);
    const issued = a.issue();
    clock.advance(1_001);
    expect(a.resume(issued.token)).toBe('EXPIRED');

    // A guest cannot act on "your token expired", so they simply become a new guest.
    const replacement = a.authenticate(issued.token);
    expect(replacement.fresh).toBe(true);
    expect(replacement.playerId).not.toBe(issued.playerId);
  });
});

describe('Matchmaking', () => {
  const matchmaker = (options?: { matchSize?: number; backfillMs?: number }) => {
    const clock = fakeClock();
    const matches: { matchId: string; seats: readonly SeatSpec[] }[] = [];
    const mm = new Matchmaker({
      matchSize: options?.matchSize ?? 4,
      backfillMs: options?.backfillMs ?? 10_000,
      clock,
      log: silentLogger(),
      onMatch: (matchId, seats) => matches.push({ matchId, seats }),
    });
    return { clock, matches, mm };
  };

  test('a full queue starts a match immediately', () => {
    const { mm, matches } = matchmaker();
    for (const id of ['a', 'b', 'c']) expect(mm.enqueue(id)).not.toBeNull();
    expect(matches).toHaveLength(0);
    mm.enqueue('d');

    expect(matches).toHaveLength(1);
    expect(matches[0]?.seats.map((s) => s.playerId)).toEqual(['a', 'b', 'c', 'd']);
    expect(matches[0]?.seats.every((s) => s.kind === 'human')).toBe(true);
    expect(mm.waiting).toBe(0);
  });

  test('a short queue is backfilled with bots after the wait', () => {
    const { mm, matches, clock } = matchmaker({ backfillMs: 10_000 });
    mm.enqueue('a');
    mm.enqueue('b');
    clock.advance(9_999);
    expect(matches).toHaveLength(0);

    clock.advance(1);
    expect(matches).toHaveLength(1);
    const seats = matches[0]?.seats ?? [];
    expect(seats.filter((s) => s.kind === 'human').map((s) => s.playerId)).toEqual(['a', 'b']);
    expect(seats.filter((s) => s.kind === 'bot')).toHaveLength(2);
    // R-01: the table is still a legal size.
    expect(seats).toHaveLength(4);
  });

  test('the backfill clock tracks whoever has waited longest', () => {
    const { mm, matches, clock } = matchmaker({ backfillMs: 10_000 });
    mm.enqueue('a');
    clock.advance(8_000);
    mm.enqueue('b'); // joining late must not reset a's wait
    clock.advance(2_000);
    expect(matches).toHaveLength(1);
  });

  test('leaving the queue stops the backfill and the match', () => {
    const { mm, matches, clock } = matchmaker({ backfillMs: 10_000 });
    mm.enqueue('a');
    expect(mm.remove('a')).toBe(true);
    expect(mm.remove('a')).toBe(false);
    clock.advance(60_000);
    expect(matches).toHaveLength(0);
  });

  test('queueing twice is refused rather than double-seated', () => {
    const { mm } = matchmaker();
    expect(mm.enqueue('a')).not.toBeNull();
    expect(mm.enqueue('a')).toBeNull();
    expect(mm.waiting).toBe(1);
  });

  test('the reported wait counts down', () => {
    const { mm, clock } = matchmaker({ backfillMs: 10_000 });
    const status = mm.enqueue('a');
    expect(status).toMatchObject({ target: 4, backfillInMs: 10_000 });
    clock.advance(4_000);
    expect(mm.status().backfillInMs).toBe(6_000);
  });
});

describe('Inbound framing', () => {
  test('a well-formed message parses', () => {
    const result = parseClientMessage(
      JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }),
    );
    expect(result.ok).toBe(true);
  });

  test('junk is a value, not an exception', () => {
    for (const bad of ['', 'not json', '{"type":"nope"}', '{"type":"bid"}', '[]', 'null']) {
      const result = parseClientMessage(bad);
      expect(result.ok, bad).toBe(false);
      if (!result.ok) expect(result.code).toBe('BAD_MESSAGE');
    }
  });

  test('an oversized frame is refused before it is parsed', () => {
    const huge = JSON.stringify({ type: 'hello', protocolVersion: 1, token: 'x'.repeat(10_000) });
    const result = parseClientMessage(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MESSAGE_TOO_LARGE');
    expect(huge.length).toBeGreaterThan(MAX_MESSAGE_BYTES);
  });

  test('a bid with an illegal face never reaches the engine', () => {
    const result = parseClientMessage(
      JSON.stringify({ type: 'bid', matchId: 'M', bid: { quantity: 2, face: 9 } }),
    );
    expect(result.ok).toBe(false);
  });

  test('unknown fields are refused rather than carried', () => {
    const result = parseClientMessage(
      JSON.stringify({ type: 'dudo', matchId: 'M', playerId: 'someone-else' }),
    );
    // Spoofing a player id is not a thing the protocol can express — the server uses the
    // authenticated session and this shape does not parse at all.
    expect(result.ok).toBe(false);
  });
});

describe('Configuration', () => {
  test('defaults are the rule values from docs/RULES.md', () => {
    const config = loadConfig({ NODE_ENV: 'test', AUTH_SECRET: 'x'.repeat(32) });
    expect(config.TURN_MS).toBe(30_000); // R-16
    expect(config.RECONNECT_GRACE_MS).toBe(45_000); // R-18
    expect(config.MATCH_SIZE).toBe(4);
  });

  test('production refuses to boot without a signing secret', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/AUTH_SECRET/);
  });

  test('development invents a throwaway secret so the server just runs', () => {
    const config = loadConfig({ NODE_ENV: 'development' });
    expect(config.AUTH_SECRET.length).toBeGreaterThanOrEqual(32);
  });

  test('a malformed value is a startup failure, not a surprise at runtime', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', MATCH_SIZE: '9' })).toThrow(/MATCH_SIZE/);
    expect(() => loadConfig({ NODE_ENV: 'test', TURN_MS: 'soon' })).toThrow(/TURN_MS/);
  });
});
