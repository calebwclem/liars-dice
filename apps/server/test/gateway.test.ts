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
 * Gateway behaviour that is about the socket rather than the game: the limits PLAN.md asks
 * for from day one, and the session rules around `hello`.
 */
describe('Socket hardening', () => {
  let http: Server;
  let gateway: Gateway;
  let url = '';
  const open: WebSocket[] = [];

  const connect = async (): Promise<{ socket: WebSocket; received: ServerMessage[] }> => {
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
    return { socket, received };
  };

  const settle = (ms = 120): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_SECRET: 'gateway-test-secret-key-0123456789ab',
      // The real defaults, so this file tests the shipped values.
      RATE_LIMIT_BURST: '20',
      RATE_LIMIT_PER_SECOND: '5',
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

  test('a flood is rate-limited and then hung up on', async () => {
    const { socket, received } = await connect();
    socket.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
    await settle();

    const closed = new Promise<number>((resolve) => {
      socket.once('close', (code: number) => {
        resolve(code);
      });
    });
    for (let i = 0; i < 60; i += 1) socket.send(JSON.stringify({ type: 'ping' }));

    expect(await closed).toBe(1008);
    expect(received.some((m) => m.type === 'error' && m.code === 'RATE_LIMITED')).toBe(true);
    // The burst was served before the limit bit.
    expect(received.filter((m) => m.type === 'pong').length).toBeGreaterThanOrEqual(15);
  });

  test('an oversized frame is refused and the socket closed', async () => {
    const { socket, received } = await connect();
    const closed = new Promise<number>((resolve) => {
      socket.once('close', (code: number) => {
        resolve(code);
      });
    });
    socket.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        token: 'x'.repeat(9_000),
      }),
    );

    expect(await closed).toBe(1009);
    expect(received.some((m) => m.type === 'error' && m.code === 'MESSAGE_TOO_LARGE')).toBe(true);
  });

  test('malformed JSON is answered, not fatal', async () => {
    const { socket, received } = await connect();
    socket.send('{not json');
    await settle();
    expect(received.some((m) => m.type === 'error' && m.code === 'BAD_MESSAGE')).toBe(true);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  test('a binary frame is refused', async () => {
    const { socket, received } = await connect();
    socket.send(Buffer.from([0x01, 0x02, 0x03]));
    await settle();
    expect(received.some((m) => m.type === 'error' && m.code === 'BAD_MESSAGE')).toBe(true);
  });

  test('presenting the same token again restores the identity and replaces the socket', async () => {
    const first = await connect();
    first.socket.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
    await settle();
    const welcome = first.received.find((m) => m.type === 'welcome');
    expect(welcome?.type).toBe('welcome');
    if (welcome?.type !== 'welcome') return;

    const closed = new Promise<void>((resolve) => {
      first.socket.once('close', () => {
        resolve();
      });
    });
    const second = await connect();
    second.socket.send(
      JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION, token: welcome.token }),
    );
    await closed; // the stale socket is dropped rather than left to linger

    const again = second.received.find((m) => m.type === 'welcome');
    expect(again?.type === 'welcome' && again.playerId).toBe(welcome.playerId);
  });

  test('a garbage token yields a new guest rather than an error', async () => {
    const { socket, received } = await connect();
    socket.send(
      JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION, token: 'forged.1.2' }),
    );
    await settle();
    const welcome = received.find((m) => m.type === 'welcome');
    expect(welcome?.type).toBe('welcome');
    expect(received.some((m) => m.type === 'error')).toBe(false);
  });

  test('cancelling a queue you are not in is refused', async () => {
    const { socket, received } = await connect();
    socket.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
    await settle();
    socket.send(JSON.stringify({ type: 'cancelQueue' }));
    await settle();
    expect(received.some((m) => m.type === 'error' && m.code === 'NOT_QUEUED')).toBe(true);
  });

  test('queueing reports the wait, and queueing twice is refused', async () => {
    const { socket, received } = await connect();
    socket.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
    await settle();
    socket.send(JSON.stringify({ type: 'findMatch' }));
    await settle();
    const queued = received.find((m) => m.type === 'queued');
    expect(queued).toMatchObject({ type: 'queued', target: 4 });

    socket.send(JSON.stringify({ type: 'findMatch' }));
    await settle();
    expect(received.some((m) => m.type === 'error' && m.code === 'ALREADY_QUEUED')).toBe(true);
    expect(gateway.roomCount).toBe(0);
  });

  test('acting in a match that does not exist is refused', async () => {
    const { socket, received } = await connect();
    socket.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
    await settle();
    socket.send(JSON.stringify({ type: 'dudo', matchId: 'no-such-match' }));
    await settle();
    expect(received.some((m) => m.type === 'error' && m.code === 'UNKNOWN_MATCH')).toBe(true);
  });
});
