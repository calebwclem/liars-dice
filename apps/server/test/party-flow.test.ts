import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { PROTOCOL_VERSION, ServerMessageSchema, type ServerMessage } from '@liars-dice/protocol';
import { createAuth } from '../src/auth.ts';
import { systemClock } from '../src/clock.ts';
import { loadConfig } from '../src/env.ts';
import { Gateway } from '../src/gateway.ts';
import { silentLogger } from '../src/logger.ts';
import { cryptoRng } from '../src/rng.ts';

/**
 * Private games over real sockets.
 *
 * `party.test.ts` covers the registry in isolation; this covers the wiring — that a code read
 * out by one player and typed by another lands them in the same match, and that the waiting
 * places stay mutually exclusive. Two separate things can each be right while the seam
 * between them is wrong, and the seam is what a player actually walks across.
 */
describe('Private games end to end', () => {
  let http: Server;
  let gateway: Gateway;
  let url = '';
  const open: WebSocket[] = [];

  interface Client {
    readonly socket: WebSocket;
    readonly received: ServerMessage[];
    readonly playerId: string;
    send: (message: unknown) => void;
    last: <T extends ServerMessage['type']>(
      type: T,
    ) => Extract<ServerMessage, { type: T }> | undefined;
  }

  const settle = (ms = 120): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /** Connect and say hello, returning once the welcome has arrived. */
  const client = async (): Promise<Client> => {
    const socket = new WebSocket(url);
    const received: ServerMessage[] = [];
    socket.on('message', (data: Buffer) => {
      const parsed = ServerMessageSchema.safeParse(JSON.parse(data.toString('utf8')));
      if (parsed.success) received.push(parsed.data);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve();
      });
      socket.once('error', reject);
    });
    open.push(socket);
    socket.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
    await settle();
    const welcome = received.find((message) => message.type === 'welcome');
    if (welcome === undefined) throw new Error('no welcome');
    return {
      socket,
      received,
      playerId: welcome.playerId,
      send: (message) => {
        socket.send(JSON.stringify(message));
      },
      last: <T extends ServerMessage['type']>(type: T) =>
        [...received].reverse().find((message) => message.type === type) as
          Extract<ServerMessage, { type: T }> | undefined,
    };
  };

  beforeEach(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_SECRET: 'party-test-secret-key-0123456789abcd',
      MATCH_SIZE: '4',
      // Long enough that the public queue never fires during these tests.
      QUEUE_BACKFILL_MS: '600000',
    });
    http = createServer();
    gateway = new Gateway({
      config,
      clock: systemClock(),
      auth: createAuth({
        secret: config.AUTH_SECRET,
        ttlMs: config.TOKEN_TTL_MS,
        clock: systemClock(),
      }),
      rng: cryptoRng(),
      log: silentLogger(),
      server: new WebSocketServer({ server: http }),
    });
    await new Promise<void>((resolve) => {
      http.listen(0, '127.0.0.1', resolve);
    });
    url = `ws://127.0.0.1:${String((http.address() as AddressInfo).port)}`;
  });

  afterEach(async () => {
    for (const socket of open) socket.close();
    open.length = 0;
    await gateway.close();
    await new Promise<void>((resolve) => {
      http.close(() => {
        resolve();
      });
    });
  });

  test('a code gets two players into the same match', async () => {
    const host = await client();
    host.send({ type: 'createParty' });
    await settle();

    const created = host.last('partyState');
    expect(created?.hostId).toBe(host.playerId);
    expect(created?.members).toEqual([host.playerId]);
    const code = created?.code ?? '';
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);

    const guest = await client();
    guest.send({ type: 'joinParty', code });
    await settle();

    // Both sides see the same party, not just the one who acted.
    expect(host.last('partyState')?.members).toEqual([host.playerId, guest.playerId]);
    expect(guest.last('partyState')?.members).toEqual([host.playerId, guest.playerId]);

    host.send({ type: 'startParty', fillWithBots: false });
    await settle(400);

    const hostMatch = host.last('matchFound');
    const guestMatch = guest.last('matchFound');
    expect(hostMatch).toBeDefined();
    expect(hostMatch?.matchId).toBe(guestMatch?.matchId);
    // Two humans, nobody else — `fillWithBots: false` was honoured.
    expect(hostMatch?.seats.map((seat) => seat.playerId).sort()).toEqual(
      [host.playerId, guest.playerId].sort(),
    );
    // The party is still standing behind the match, which is what a rematch goes back to. It
    // used to be dissolved here, and that is precisely why there was nothing to play again.
    expect(gateway.partyCount).toBe(1);
  });

  test('nobody is shown the party screen while they are at a table', async () => {
    // A party outlives the match it starts, so its membership can change while that match is
    // being played — a friend arriving with the code, someone giving up. Every client shows the
    // party when it receives a `partyState`, so sending one to a player mid-match would take
    // the match off their screen. The gateway is the only thing that knows who is in a room,
    // so it is the gateway that holds those back.
    const host = await client();
    host.send({ type: 'createParty' });
    await settle();
    const code = host.last('partyState')?.code ?? '';

    const guest = await client();
    guest.send({ type: 'joinParty', code });
    await settle();
    host.send({ type: 'startParty', fillWithBots: false });
    await settle(400);
    expect(host.last('matchFound')).toBeDefined();

    const count = (who: typeof host): number =>
      who.received.filter((message) => message.type === 'partyState').length;
    const before = count(host);

    const latecomer = await client();
    latecomer.send({ type: 'joinParty', code });
    await settle();

    // The latecomer is in the room and can see it; the two who are playing were not told.
    expect(latecomer.last('partyState')?.members).toContain(latecomer.playerId);
    expect(count(host), 'a player mid-match was shown the party screen').toBe(before);
    expect(gateway.partyCount).toBe(1);
  });

  test('a rematch is refused while the match is still being played', async () => {
    const host = await client();
    host.send({ type: 'createParty' });
    await settle();
    const code = host.last('partyState')?.code ?? '';
    const guest = await client();
    guest.send({ type: 'joinParty', code });
    await settle();
    host.send({ type: 'startParty', fillWithBots: false });
    await settle(400);

    host.send({ type: 'rematch' });
    await settle();
    expect(host.last('error')?.code).toBe('ALREADY_IN_MATCH');
  });

  test('a rematch is refused when there is no party to go back to', async () => {
    // A match found through the public queue has no "same people" to reassemble.
    const alone = await client();
    alone.send({ type: 'rematch' });
    await settle();
    expect(alone.last('error')?.code).toBe('NOT_IN_PARTY');
  });

  test('leaving the table leaves the party it came from', async () => {
    // Otherwise a player who said they were done gets pulled into the next match by somebody
    // else's host button.
    const host = await client();
    host.send({ type: 'createParty' });
    await settle();
    const code = host.last('partyState')?.code ?? '';
    const guest = await client();
    guest.send({ type: 'joinParty', code });
    await settle();
    host.send({ type: 'startParty', fillWithBots: true });
    await settle(400);
    const matchId = guest.last('matchFound')?.matchId ?? '';

    guest.send({ type: 'leave', matchId });
    await settle();
    guest.send({ type: 'rematch' });
    await settle();
    expect(guest.last('error')?.code).toBe('NOT_IN_PARTY');
    // And leaving is not itself an error, however finished the match is.
    expect(guest.received.filter((message) => message.type === 'error').length).toBe(1);
  });

  test('filling with bots seats a full table for two friends', async () => {
    const host = await client();
    host.send({ type: 'createParty' });
    await settle();
    const code = host.last('partyState')?.code ?? '';

    const guest = await client();
    guest.send({ type: 'joinParty', code });
    await settle();

    host.send({ type: 'startParty', fillWithBots: true });
    await settle(400);

    const seats = host.last('matchFound')?.seats ?? [];
    expect(seats).toHaveLength(4);
    const humans = seats.filter((seat) => seat.control === 'human').map((seat) => seat.playerId);
    expect(humans.sort()).toEqual([host.playerId, guest.playerId].sort());
  });

  test('a wrong code is refused and leaves you where you were', async () => {
    const guest = await client();
    guest.send({ type: 'joinParty', code: 'ZZZZ' });
    await settle();
    expect(guest.last('error')?.code).toBe('UNKNOWN_PARTY');
    expect(guest.last('partyState')).toBeUndefined();
  });

  test('a malformed code never reaches the registry', async () => {
    // The schema rejects it as a bad message, so `Parties` is never asked about a code that
    // could not exist. Lowercase is the common case — the client is expected to uppercase.
    const guest = await client();
    guest.send({ type: 'joinParty', code: 'abcd' });
    await settle();
    expect(guest.last('error')?.code).toBe('BAD_MESSAGE');
  });

  test('only the host can start, and not on their own', async () => {
    const host = await client();
    host.send({ type: 'createParty' });
    await settle();
    const code = host.last('partyState')?.code ?? '';

    host.send({ type: 'startParty', fillWithBots: true });
    await settle();
    expect(host.last('error')?.code).toBe('PARTY_TOO_SMALL');

    const guest = await client();
    guest.send({ type: 'joinParty', code });
    await settle();
    guest.send({ type: 'startParty', fillWithBots: false });
    await settle();
    expect(guest.last('error')?.code).toBe('NOT_PARTY_HOST');
  });

  test('the waiting places are mutually exclusive', async () => {
    const player = await client();
    player.send({ type: 'createParty' });
    await settle();
    player.send({ type: 'findMatch' });
    await settle();
    expect(player.last('error')?.code).toBe('ALREADY_IN_PARTY');

    player.send({ type: 'leaveParty' });
    await settle();
    expect(player.last('partyLeft')).toBeDefined();

    player.send({ type: 'findMatch' });
    await settle();
    expect(player.last('queued')).toBeDefined();

    player.send({ type: 'createParty' });
    await settle();
    expect(player.last('error')?.code).toBe('ALREADY_QUEUED');
  });

  test('a dropped socket leaves the party and the rest are told', async () => {
    const host = await client();
    host.send({ type: 'createParty' });
    await settle();
    const code = host.last('partyState')?.code ?? '';

    const guest = await client();
    guest.send({ type: 'joinParty', code });
    await settle();
    expect(host.last('partyState')?.members).toHaveLength(2);

    guest.socket.close();
    await settle(200);
    expect(host.last('partyState')?.members).toEqual([host.playerId]);
  });

  test('the host dropping passes the party on rather than dissolving it', async () => {
    const host = await client();
    host.send({ type: 'createParty' });
    await settle();
    const code = host.last('partyState')?.code ?? '';

    const guest = await client();
    guest.send({ type: 'joinParty', code });
    await settle();

    host.socket.close();
    await settle(200);

    const party = guest.last('partyState');
    expect(party?.hostId).toBe(guest.playerId);
    expect(party?.members).toEqual([guest.playerId]);
    // And the code still works, so a host whose wifi blipped can walk straight back in.
    const third = await client();
    third.send({ type: 'joinParty', code });
    await settle();
    expect(third.last('partyState')?.members).toHaveLength(2);
  });
});
