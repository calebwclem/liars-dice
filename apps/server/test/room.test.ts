import { describe, expect, test } from 'vitest';
import { minimumLegalBid } from '@liars-dice/engine';
import type { ServerMessage } from '@liars-dice/protocol';
import { onTurn, openRoom, TEST_TIMINGS } from './helpers.ts';

const eventTypes = (events: readonly { type: string }[]): string[] => events.map((e) => e.type);

/** The rules the engine deliberately does not know about. */
describe('R-16 the turn timer', () => {
  test('R-16: a turn carries a 30-second deadline, counted down in the snapshot', () => {
    const h = openRoom();
    expect(h.latest('a').snapshot.turnEndsInMs).toBe(TEST_TIMINGS.turnMs);

    h.clock.advance(10_000);
    // The deadline is only recomputed when a message goes out, so provoke one.
    h.room.resume('a', 0);
    expect(h.latest('a').snapshot.turnEndsInMs).toBe(20_000);
  });

  test('R-16: nothing happens a moment before the deadline', () => {
    const h = openRoom();
    const before = h.states('a').length;
    h.clock.advance(TEST_TIMINGS.turnMs - 1);
    expect(h.states('a').length).toBe(before);
    expect(h.room.debugState.round.bids).toHaveLength(0);
  });

  test('R-16: the timer is enforced server-side, not by whoever is on turn', () => {
    const h = openRoom();
    h.clock.advance(TEST_TIMINGS.turnMs);
    expect(eventTypes(h.events('a'))).toContain('playerTimedOut');
  });

  test('R-16: an unrelated reconnect does not hand the player on turn a fresh 30 seconds', () => {
    const h = openRoom();
    const actor = onTurn(h.room);
    const bystander = h.room.playerIds.find((id) => id !== actor);
    expect(bystander).toBeDefined();

    h.clock.advance(20_000);
    h.room.onDisconnected(bystander!);
    h.room.onConnected(bystander!);
    h.room.resume(actor, 0);
    expect(h.latest(actor).snapshot.turnEndsInMs).toBe(10_000);

    // ...and the deadline still lands where it originally would have.
    h.clock.advance(10_000);
    expect(eventTypes(h.events(actor))).toContain('playerTimedOut');
  });
});

describe('R-17 the timeout auto-bid and AFK takeover', () => {
  test('R-17: the first timeout plays the minimum legal raise for the player', () => {
    const h = openRoom();
    const actor = onTurn(h.room);
    const expected = minimumLegalBid(h.room.debugState);
    expect(expected).toEqual({ quantity: 1, face: 2 }); // the weakest bid in the game

    h.clock.advance(TEST_TIMINGS.turnMs);

    const events = h.events(actor);
    const timedOut = events.find((e) => e.type === 'playerTimedOut');
    expect(timedOut).toMatchObject({ playerId: actor, consecutive: 1, autoBid: expected });
    expect(events.find((e) => e.type === 'bidMade')).toMatchObject({
      playerId: actor,
      bid: expected,
    });
    expect(h.room.debugState.round.bids).toHaveLength(1);
    // Play moved on: the seat is still theirs.
    expect(h.latest(actor).snapshot.seats[0]?.control).toBe('human');
  });

  test('R-17: a second consecutive timeout hands the seat to a bot', () => {
    const h = openRoom({
      seats: [
        { playerId: 'a', kind: 'human' },
        { playerId: 'b', kind: 'human' },
      ],
    });
    // a times out, then b times out, then a times out again — a's two are consecutive.
    h.clock.advance(TEST_TIMINGS.turnMs); // a, auto-bid
    h.clock.advance(TEST_TIMINGS.turnMs); // b, auto-bid
    h.clock.advance(TEST_TIMINGS.turnMs); // a again

    const takeover = h.events('a').find((e) => e.type === 'botTookOver');
    expect(takeover).toMatchObject({ playerId: 'a', reason: 'afk' });
    expect(h.latest('a').snapshot.seats.find((s) => s.playerId === 'a')).toMatchObject({
      control: 'bot',
      controlReason: 'afk',
    });
  });

  test('R-17: acting voluntarily clears the streak, so timeouts must be consecutive', () => {
    const h = openRoom({
      seats: [
        { playerId: 'a', kind: 'human' },
        { playerId: 'b', kind: 'human' },
      ],
    });

    h.clock.advance(TEST_TIMINGS.turnMs); // a times out — streak 1, auto-bid (1,2)
    expect(onTurn(h.room)).toBe('b');
    expect(h.room.submit('b', { type: 'bid', bid: { quantity: 1, face: 3 } })).toBeNull();
    // a acts of their own accord, which is what clears the streak.
    expect(h.room.submit('a', { type: 'bid', bid: { quantity: 1, face: 4 } })).toBeNull();
    expect(h.room.submit('b', { type: 'bid', bid: { quantity: 1, face: 5 } })).toBeNull();

    h.clock.advance(TEST_TIMINGS.turnMs); // a times out again — streak 1, not 2

    const timeouts = h.events('a').filter((e) => e.type === 'playerTimedOut');
    expect(timeouts).toHaveLength(2);
    expect(timeouts.at(-1)).toMatchObject({ playerId: 'a', consecutive: 1 });
    expect(eventTypes(h.events('a'))).not.toContain('botTookOver');
  });

  test('R-17: once a bot holds the seat, the player cannot act on it', () => {
    const h = openRoom({
      seats: [
        { playerId: 'a', kind: 'human' },
        { playerId: 'b', kind: 'human' },
      ],
    });
    h.clock.advance(TEST_TIMINGS.turnMs * 3); // a times out twice
    expect(h.room.submit('a', { type: 'bid', bid: { quantity: 2, face: 4 } })).toBe(
      'SEAT_NOT_YOURS',
    );
  });

  test('R-17: a bot-held seat keeps playing on its own', () => {
    const h = openRoom({
      seats: [
        { playerId: 'a', kind: 'human' },
        { playerId: 'b', kind: 'human' },
      ],
    });
    h.clock.advance(TEST_TIMINGS.turnMs * 3);
    const before = h.room.debugState.seq;
    h.clock.advance(TEST_TIMINGS.botThinkMs * 4 + TEST_TIMINGS.revealMs * 2);
    expect(h.room.debugState.seq).toBeGreaterThan(before);
  });
});

describe('R-18 disconnection and resync', () => {
  test('R-18: a disconnect announces the grace period rather than ending the turn', () => {
    const h = openRoom();
    h.room.onDisconnected('b');
    const event = h.events('a').find((e) => e.type === 'playerDisconnected');
    expect(event).toMatchObject({ playerId: 'b', graceMs: TEST_TIMINGS.reconnectGraceMs });
    expect(h.latest('a').snapshot.seats.find((s) => s.playerId === 'b')?.connected).toBe(false);
  });

  test('R-18: coming back inside 45 seconds returns control', () => {
    const h = openRoom();
    h.room.onDisconnected('b');
    h.clock.advance(TEST_TIMINGS.reconnectGraceMs - 1);
    h.room.onConnected('b');
    h.clock.advance(TEST_TIMINGS.reconnectGraceMs);

    const events = eventTypes(h.events('a'));
    expect(events).toContain('playerReconnected');
    expect(events).not.toContain('botTookOver');
    expect(h.latest('a').snapshot.seats.find((s) => s.playerId === 'b')).toMatchObject({
      connected: true,
      control: 'human',
    });
  });

  test('R-18: 45 seconds gone and a bot takes the seat', () => {
    const h = openRoom();
    h.room.onDisconnected('b');
    h.clock.advance(TEST_TIMINGS.reconnectGraceMs);
    expect(h.events('a').find((e) => e.type === 'botTookOver')).toMatchObject({
      playerId: 'b',
      reason: 'disconnected',
    });
  });

  test('R-18: a player who comes back after the takeover gets their seat back', () => {
    // R-17's AFK takeover is "for the rest of the match"; R-18's is not — the rule says the
    // reconnecting client "resumes control".
    const h = openRoom();
    h.room.onDisconnected('b');
    h.clock.advance(TEST_TIMINGS.reconnectGraceMs);
    h.room.onConnected('b');
    expect(eventTypes(h.events('a'))).toContain('controlReturned');
    expect(h.latest('a').snapshot.seats.find((s) => s.playerId === 'b')).toMatchObject({
      connected: true,
      control: 'human',
      controlReason: null,
    });
  });

  test('R-18: an AFK seat is not handed back on reconnect', () => {
    const h = openRoom({
      seats: [
        { playerId: 'a', kind: 'human' },
        { playerId: 'b', kind: 'human' },
      ],
    });
    h.clock.advance(TEST_TIMINGS.turnMs * 3); // a goes AFK
    h.room.onDisconnected('a');
    h.room.onConnected('a');
    expect(h.latest('a').snapshot.seats.find((s) => s.playerId === 'a')).toMatchObject({
      control: 'bot',
      controlReason: 'afk',
    });
  });

  test('R-18: resume answers with a full snapshot and the events that were missed', () => {
    const h = openRoom();
    const actor = onTurn(h.room);
    expect(h.room.submit(actor, { type: 'bid', bid: { quantity: 3, face: 4 } })).toBeNull();
    const seqBeforeMore = h.latest(actor).seq;

    const next = onTurn(h.room);
    expect(h.room.submit(next, { type: 'bid', bid: { quantity: 4, face: 4 } })).toBeNull();

    h.room.resume(actor, seqBeforeMore);
    const sync = h.latest(actor);
    expect(sync.kind).toBe('sync');
    expect(sync.snapshot.view.round.bids).toHaveLength(2);
    expect(eventTypes(sync.events)).toEqual(['bidMade']);
  });

  test('R-18: a resync from seq 0 still works, just without the replay', () => {
    const h = openRoom();
    h.room.resume('a', 0);
    const sync = h.latest('a');
    expect(sync.kind).toBe('sync');
    expect(sync.snapshot.view.you?.id).toBe('a');
    expect(sync.snapshot.view.you?.dice).toHaveLength(5);
  });
});

describe('R-19 abandonment', () => {
  test('R-19: the match is abandoned when the last human disconnects', () => {
    const h = openRoom();
    h.room.onDisconnected('a');
    h.room.onDisconnected('b');
    h.room.onDisconnected('c');
    expect(h.room.currentStatus).toBe('active');
    h.room.onDisconnected('d');

    expect(h.room.currentStatus).toBe('abandoned');
    expect(h.events('a').find((e) => e.type === 'matchAbandoned')).toMatchObject({
      reason: 'allHumansDisconnected',
    });
    expect(h.finished).toBe(h.room);
    expect(h.clock.pending()).toBe(0); // every timer stopped
  });

  test('R-19: bots in the seats do not keep an empty room alive', () => {
    const h = openRoom({
      seats: [
        { playerId: 'a', kind: 'human' },
        { playerId: 'bot1', kind: 'bot' },
        { playerId: 'bot2', kind: 'bot' },
        { playerId: 'bot3', kind: 'bot' },
      ],
    });
    h.room.onDisconnected('a');
    expect(h.room.currentStatus).toBe('abandoned');
  });

  test('R-19: leaving deliberately skips the grace period', () => {
    const h = openRoom();
    h.room.onLeft('b');
    expect(h.events('a').find((e) => e.type === 'botTookOver')).toMatchObject({
      playerId: 'b',
      reason: 'disconnected',
    });
    expect(h.room.currentStatus).toBe('active');
  });

  test('R-19: nothing is accepted once the match is over', () => {
    const h = openRoom();
    for (const id of ['a', 'b', 'c', 'd']) h.room.onDisconnected(id);
    expect(h.room.submit('a', { type: 'bid', bid: { quantity: 1, face: 2 } })).toBe('MATCH_ENDED');
  });
});

describe('R-03 / R-20 the room never leaks a hand', () => {
  /** Every path in a value that holds an array of die faces. */
  const dicePaths = (value: unknown, path = ''): string[] => {
    if (Array.isArray(value)) {
      const faces = value.every((v) => typeof v === 'number' && v >= 1 && v <= 6);
      if (value.length > 0 && faces) return [path];
      return value.flatMap((v, i) => dicePaths(v, `${path}[${String(i)}]`));
    }
    if (value !== null && typeof value === 'object') {
      return Object.entries(value).flatMap(([k, v]) =>
        dicePaths(v, path === '' ? k : `${path}.${k}`),
      );
    }
    return [];
  };

  test('R-20: no message ever carries a hand that is not the recipient’s own', () => {
    const h = openRoom();
    // Drive a whole match: bots take every seat, so the room plays itself out.
    for (const id of h.room.playerIds) h.room.onLeft(id);
    // (onLeft on the last human abandons the match, so instead time the seats out.)
    const live = openRoom();
    live.clock.advance(TEST_TIMINGS.turnMs * 2); // seat one goes AFK, bot takes over
    live.clock.advance(60 * 60 * 1_000); // an hour of bot play finishes the match

    expect(live.room.currentStatus).toBe('ended');
    expect(live.sent.length).toBeGreaterThan(20);

    for (const { playerId, message } of live.sent) {
      const wire: unknown = JSON.parse(JSON.stringify(message));
      const leaked = dicePaths(wire).filter(
        (p) =>
          p !== 'snapshot.view.you.dice' &&
          !p.startsWith('snapshot.view.lastReveal.hands.') &&
          !/^events\[\d+]\.reveal\.hands\./.test(p),
      );
      expect(leaked, `${playerId} received ${message.type}`).toEqual([]);
    }
  });

  test('R-03: each player is told their own dice and only a count for everyone else', () => {
    const h = openRoom();
    for (const playerId of ['a', 'b', 'c', 'd']) {
      const snapshot = h.latest(playerId).snapshot;
      expect(snapshot.view.you?.id).toBe(playerId);
      expect(snapshot.view.you?.dice).toHaveLength(5);
      expect(snapshot.view.players).toHaveLength(4);
      for (const player of snapshot.view.players) expect(player.diceCount).toBe(5);
    }
    // Four different hands were dealt, and each player saw exactly one of them.
    const hands = ['a', 'b', 'c', 'd'].map((id) =>
      JSON.stringify(h.latest(id).snapshot.view.you?.dice),
    );
    expect(new Set(hands).size).toBeGreaterThan(1);
  });

  test('every outbound message satisfies the protocol schema', async () => {
    const { ServerMessageSchema } = await import('@liars-dice/protocol');
    const h = openRoom();
    h.clock.advance(TEST_TIMINGS.turnMs * 2);
    h.clock.advance(60 * 60 * 1_000);
    for (const { message } of h.sent) {
      const wire: unknown = JSON.parse(JSON.stringify(message satisfies ServerMessage));
      const parsed = ServerMessageSchema.safeParse(wire);
      if (!parsed.success) expect.unreachable(`${message.type}: ${parsed.error.message}`);
    }
  });
});
