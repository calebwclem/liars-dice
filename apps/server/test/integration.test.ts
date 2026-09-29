import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { checkBidIn, bidContextOfView, legalBidsIn, type Bid } from '@liars-dice/engine';
import {
  PROTOCOL_VERSION,
  ServerMessageSchema,
  type ClientMessage,
  type MatchSnapshot,
  type ServerMessage,
} from '@liars-dice/protocol';
import { createAuth } from '../src/auth.ts';
import { systemClock } from '../src/clock.ts';
import { loadConfig } from '../src/env.ts';
import { Gateway } from '../src/gateway.ts';
import { silentLogger } from '../src/logger.ts';
import { cryptoRng } from '../src/rng.ts';

/**
 * The Phase 2 done-criterion: four in-process clients play a full match over real
 * WebSockets, one of them drops mid-round and resyncs, and no message any of them receives
 * ever contains another player's dice.
 *
 * Real sockets on a real port, because the things most likely to be wrong here — framing,
 * reconnection, who gets which snapshot — are exactly the things an in-memory fake would
 * paper over. Timings are compressed so a full match takes seconds rather than minutes;
 * R-16 and R-18 are tested against their real values in room.test.ts, on a fake clock.
 */

/** A minimal client: what the iOS app will do, in about sixty lines. */
class TestClient {
  readonly received: ServerMessage[] = [];
  playerId = '';
  token = '';
  matchId: string | null = null;
  snapshot: MatchSnapshot | null = null;
  lastSeq = 0;
  private socket: WebSocket;
  private readonly url: string;
  private readonly waiters: {
    match: (m: ServerMessage) => boolean;
    resolve: (m: ServerMessage) => void;
  }[] = [];

  private constructor(url: string, socket: WebSocket) {
    this.url = url;
    this.socket = socket;
    this.listen();
  }

  static async connect(url: string): Promise<TestClient> {
    const socket = new WebSocket(url);
    await once(socket, 'open');
    return new TestClient(url, socket);
  }

  private listen(): void {
    this.socket.on('message', (data: Buffer) => {
      const parsed = ServerMessageSchema.safeParse(JSON.parse(data.toString('utf8')));
      if (!parsed.success)
        throw new Error(`server sent something off-contract: ${parsed.error.message}`);
      const message = parsed.data;
      this.received.push(message);

      if (message.type === 'welcome') {
        this.playerId = message.playerId;
        this.token = message.token;
      }
      if (message.type === 'matchFound') this.matchId = message.matchId;
      if (message.type === 'state') {
        this.lastSeq = message.seq;
        this.snapshot = message.snapshot;
      }
      for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
        const waiter = this.waiters[i];
        if (waiter?.match(message) === true) {
          this.waiters.splice(i, 1);
          waiter.resolve(message);
        }
      }
    });
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  /** Resolve on the next message matching `match`, or on one already received. */
  async waitFor(match: (m: ServerMessage) => boolean, timeoutMs = 10_000): Promise<ServerMessage> {
    const existing = this.received.find(match);
    if (existing !== undefined) return existing;
    return new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('timed out waiting for a message'));
      }, timeoutMs);
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  async hello(token?: string): Promise<void> {
    this.send(
      token === undefined
        ? { type: 'hello', protocolVersion: PROTOCOL_VERSION }
        : { type: 'hello', protocolVersion: PROTOCOL_VERSION, token },
    );
    await this.waitFor((m) => m.type === 'welcome' || m.type === 'updateRequired');
  }

  /** Drop the socket the way a phone in a lift does: no close frame, no warning. */
  drop(): void {
    this.socket.terminate();
  }

  async reconnect(): Promise<void> {
    this.socket.removeAllListeners();
    this.socket = new WebSocket(this.url);
    await once(this.socket, 'open');
    this.listen();
    await this.hello(this.token);
  }

  close(): void {
    this.socket.removeAllListeners();
    this.socket.close();
  }

  get errors(): readonly Extract<ServerMessage, { type: 'error' }>[] {
    return this.received.filter(
      (m): m is Extract<ServerMessage, { type: 'error' }> => m.type === 'error',
    );
  }

  get isMyTurn(): boolean {
    const phase = this.snapshot?.view.phase;
    return phase?.kind === 'bidding' && phase.turnId === this.playerId;
  }

  /** A legal move from the redacted view alone — exactly what the iOS client will do. */
  nextMove(challengeChance: number, random: () => number): ClientMessage | null {
    const view = this.snapshot?.view;
    if (view === undefined || this.matchId === null || !this.isMyTurn) return null;
    const context = bidContextOfView(view);
    const options = legalBidsIn(context);
    const mustBid = view.round.bids.length === 0; // R-06
    if (options.length === 0) return { type: 'dudo', matchId: this.matchId };
    if (!mustBid && random() < challengeChance) return { type: 'dudo', matchId: this.matchId };
    const index = Math.min(
      Math.floor(random() ** 3 * Math.min(options.length, 8)),
      options.length - 1,
    );
    const bid: Bid | undefined = options[index];
    if (bid === undefined) return { type: 'dudo', matchId: this.matchId };
    // The client believes this is legal; the server will decide (CLAUDE.md: the client may
    // disable a button, but it never rules).
    expect(checkBidIn(context, bid).ok).toBe(true);
    return { type: 'bid', matchId: this.matchId, bid };
  }
}

const once = (emitter: WebSocket, event: string): Promise<void> =>
  new Promise((resolve, reject) => {
    emitter.once(event, () => {
      resolve();
    });
    emitter.once('error', reject);
  });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for a condition, or fail saying what we were waiting for.
 *
 * Used after every move instead of a blind sleep. Sending again before the snapshot reflects
 * the last move means sending out of turn; the server rightly rejects it, and a loop doing
 * that in a tight cycle trips the rate limiter and gets itself disconnected — which is how
 * this test failed the first time it ran, and a fair imitation of a badly written client.
 */
async function waitUntil(what: string, ready: () => boolean, timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (ready()) return;
    await sleep(2);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** True when this client's own seat is still theirs to play (R-17/R-18). */
const inControl = (client: TestClient): boolean =>
  client.snapshot?.seats.find((seat) => seat.playerId === client.playerId)?.control === 'human';

const lcg = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};

/** Every path in a value that holds an array of die faces. */
function dicePaths(value: unknown, path = ''): string[] {
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
}

describe('Four clients, one server', () => {
  let http: Server;
  let gateway: Gateway;
  let url = '';
  const clients: TestClient[] = [];

  beforeEach(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_SECRET: 'integration-test-secret-key-0123456789',
      MATCH_SIZE: '4',
      // Compressed so a full match runs in seconds. The real values are exercised in
      // room.test.ts against a fake clock.
      TURN_MS: '8000',
      RECONNECT_GRACE_MS: '3000',
      REVEAL_MS: '10',
      BOT_THINK_MS: '5',
      QUEUE_BACKFILL_MS: '60000',
      // These clients play a whole match in a second, which no human can. The limiter is
      // exercised at its real values in gateway.test.ts.
      RATE_LIMIT_BURST: '1000',
      RATE_LIMIT_PER_SECOND: '1000',
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
      rng: cryptoRng(), // R-20
      log: silentLogger(),
      server: new WebSocketServer({ server: http }),
    });
    await new Promise<void>((resolve) => {
      http.listen(0, '127.0.0.1', resolve);
    });
    const address = http.address() as AddressInfo;
    url = `ws://127.0.0.1:${String(address.port)}`;
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    clients.length = 0;
    await gateway.close();
    await new Promise<void>((resolve) => {
      http.close(() => {
        resolve();
      });
    });
  });

  const seatFour = async (): Promise<TestClient[]> => {
    const four: TestClient[] = [];
    for (let i = 0; i < 4; i += 1) {
      const client = await TestClient.connect(url);
      clients.push(client);
      four.push(client);
      await client.hello();
    }
    for (const client of four) client.send({ type: 'findMatch' });
    await Promise.all(four.map((c) => c.waitFor((m) => m.type === 'matchFound')));
    await Promise.all(four.map((c) => c.waitFor((m) => m.type === 'state')));
    return four;
  };

  /** The same four, but gathered behind a code the way friends actually play. */
  const seatParty = async (): Promise<{ four: TestClient[]; code: string }> => {
    const four: TestClient[] = [];
    for (let i = 0; i < 4; i += 1) {
      const client = await TestClient.connect(url);
      clients.push(client);
      four.push(client);
      await client.hello();
    }
    const [host, ...guests] = four;
    if (host === undefined) throw new Error('no host');
    host.send({ type: 'createParty' });
    const created = await host.waitFor((m) => m.type === 'partyState');
    if (created.type !== 'partyState') throw new Error('not a partyState');
    for (const guest of guests) {
      guest.send({ type: 'joinParty', code: created.code });
      await guest.waitFor((m) => m.type === 'partyState');
    }
    host.send({ type: 'startParty', fillWithBots: false });
    await Promise.all(four.map((c) => c.waitFor((m) => m.type === 'matchFound')));
    await Promise.all(four.map((c) => c.waitFor((m) => m.type === 'state')));
    return { four, code: created.code };
  };

  const isOver = (four: readonly TestClient[]): boolean =>
    four.some((c) => c.snapshot?.view.phase.kind === 'ended');

  /** Have whoever is on turn play one legal move, and wait for it to land. */
  const playOneMove = async (
    four: readonly TestClient[],
    random: () => number,
    challengeChance: number,
  ): Promise<boolean> => {
    const actor = four.find((client) => client.isMyTurn && inControl(client));
    if (actor === undefined) return false;
    const move = actor.nextMove(challengeChance, random);
    if (move === null) return false;

    const errorsBefore = actor.errors.length;
    actor.send(move);
    await waitUntil(
      `${actor.playerId}'s ${move.type} to land`,
      () => !actor.isMyTurn || isOver(four) || actor.errors.length > errorsBefore,
    );
    // A move the client believed legal must not be refused: the client derives legality from
    // its own redacted view, and if that ever disagrees with the server the answer is a bug,
    // not something to retry around.
    const rejection = actor.errors[errorsBefore];
    if (rejection !== undefined) {
      throw new Error(
        `server refused ${JSON.stringify(move)} with ${rejection.code}` +
          ` (seat control ${String(actor.snapshot?.seats.find((s) => s.playerId === actor.playerId)?.control)},` +
          ` phase ${String(actor.snapshot?.view.phase.kind)})`,
      );
    }
    return true;
  };

  /** Play until somebody wins. */
  const playToCompletion = async (
    four: readonly TestClient[],
    deadlineMs = 30_000,
  ): Promise<void> => {
    const random = lcg(1);
    const until = Date.now() + deadlineMs;
    while (Date.now() < until) {
      if (isOver(four)) return;
      // Nobody to nudge means the room is mid-reveal or a bot is thinking; give it a moment.
      if (!(await playOneMove(four, random, 0.3))) await sleep(5);
    }
    throw new Error('match did not finish in time');
  };

  test('four friends play a match, and then play another with the same people', async () => {
    // Tier 3's flagship, end to end. A party used to be dissolved the instant it started, so
    // when the match ended there was nothing to go back to and the only button was "back to the
    // lobby". The party now outlives its match; this plays one out and asks for another.
    //
    // Everything below counts messages rather than waiting for a *type*: `waitFor` answers from
    // what has already arrived, so "wait for a matchFound" is satisfied instantly by the one
    // that started the first match. Two of these assertions passed vacuously before that was
    // noticed.
    const { four, code } = await seatParty();
    const [host] = four;
    if (host === undefined) throw new Error('no host');
    const firstMatch = host.matchId;
    const partyStates = (client: TestClient): number =>
      client.received.filter((message) => message.type === 'partyState').length;
    const seatedWith = four.map(partyStates);

    await playToCompletion(four);
    for (const client of four) expect(client.snapshot?.view.phase.kind).toBe('ended');

    // The match ending moves nobody. A `partyState` here would take the final score off the
    // screen of everyone still reading it.
    four.forEach((client, index) => {
      expect(partyStates(client), 'the match ending pushed a party screen').toBe(seatedWith[index]);
    });

    // "Play again."
    for (const client of four) client.send({ type: 'rematch' });
    await waitUntil('everyone to be back in the room', () =>
      four.every((client, index) => partyStates(client) > (seatedWith[index] ?? 0)),
    );

    for (const client of four) {
      const back = [...client.received].reverse().find((m) => m.type === 'partyState');
      if (back?.type !== 'partyState') throw new Error('no party came back');
      // Same room, same people, and the host is still the host.
      expect(back.code).toBe(code);
      expect([...back.members].sort()).toEqual(four.map((c) => c.playerId).sort());
      expect(back.hostId).toBe(host.playerId);
    }

    // And it really is startable again: a second match, with a new id and a fresh deal.
    host.send({ type: 'startParty', fillWithBots: false });
    await waitUntil(
      'the second match to be dealt',
      () =>
        four.every(
          (client) =>
            client.matchId !== firstMatch && client.snapshot?.view.phase.kind === 'bidding',
        ),
      10_000,
    );
    for (const client of four) {
      expect(client.matchId).toBe(host.matchId);
      expect(client.snapshot?.view.you?.dice).toHaveLength(5); // R-03, dealt afresh
    }
  });

  test('R-12: four clients play a full match through to a winner', async () => {
    const four = await seatFour();
    // Everyone was told the same seating, and each sees their own five dice (R-02, R-03).
    for (const client of four) {
      expect(client.snapshot?.view.players).toHaveLength(4);
      expect(client.snapshot?.view.you?.dice).toHaveLength(5);
      expect(client.snapshot?.view.you?.id).toBe(client.playerId);
    }

    await playToCompletion(four);

    const phases = four.map((c) => c.snapshot?.view.phase);
    for (const phase of phases) expect(phase?.kind).toBe('ended');
    const winners = new Set(phases.map((p) => (p?.kind === 'ended' ? p.winnerId : null)));
    expect(winners.size).toBe(1); // everyone agrees who won
    const [winner] = [...winners];
    expect(four.map((c) => c.playerId)).toContain(winner);

    // R-10: at least one challenge was revealed along the way.
    const reveals = four[0]?.received.filter(
      (m) => m.type === 'state' && m.events.some((e) => e.type === 'diceRevealed'),
    );
    expect(reveals?.length).toBeGreaterThan(0);
  });

  test('R-18: a client that drops mid-match resyncs and carries on', async () => {
    const four = await seatFour();
    const [victim, ...others] = four;
    expect(victim).toBeDefined();
    if (victim === undefined) return;

    // Play a few moves so there is something to have missed.
    const random = lcg(99);
    for (let i = 0; i < 3; i += 1) await playOneMove(four, random, 0);

    const seqBefore = victim.lastSeq;
    const bidsBefore = victim.snapshot?.view.round.bids.length ?? 0;
    victim.drop();

    // The others see them go (R-18) and keep playing.
    const other = others[0];
    expect(other).toBeDefined();
    if (other === undefined) return;
    await other.waitFor(
      (m) => m.type === 'state' && m.events.some((e) => e.type === 'playerDisconnected'),
    );
    for (let i = 0; i < 2; i += 1) await playOneMove(others, random, 0);

    // Back with the same token, then ask for everything after the last seq they saw.
    await victim.reconnect();
    expect(victim.matchId).not.toBeNull();
    victim.send({ type: 'resume', matchId: victim.matchId!, afterSeq: seqBefore });
    const sync = await victim.waitFor((m) => m.type === 'state' && m.kind === 'sync');

    expect(sync.type === 'state' && sync.seq).toBeGreaterThan(seqBefore);
    expect(victim.snapshot?.view.you?.id).toBe(victim.playerId);
    // Their own hand came back, and the match moved on while they were away.
    expect(victim.snapshot?.view.you?.dice.length).toBeGreaterThan(0);
    const bidsAfter = victim.snapshot?.view.round.bids.length ?? 0;
    expect(bidsAfter + (victim.snapshot?.view.round.index ?? 0)).toBeGreaterThanOrEqual(bidsBefore);

    // They are in control again and the others were told so.
    await other.waitFor(
      (m) => m.type === 'state' && m.events.some((e) => e.type === 'playerReconnected'),
    );
    const seat = victim.snapshot?.seats.find((s) => s.playerId === victim.playerId);
    expect(seat).toMatchObject({ connected: true, control: 'human' });

    await playToCompletion(four);
    expect(victim.snapshot?.view.phase.kind).toBe('ended');
  });

  test('R-20: no message any client receives contains another player’s dice', async () => {
    const four = await seatFour();
    await playToCompletion(four);

    let inspected = 0;
    for (const client of four) {
      for (const message of client.received) {
        const wire: unknown = JSON.parse(JSON.stringify(message));
        const leaked = dicePaths(wire).filter(
          (path) =>
            // Your own hand, and hands made public by a reveal (R-10). Nothing else.
            path !== 'snapshot.view.you.dice' &&
            !path.startsWith('snapshot.view.lastReveal.hands.') &&
            !/^events\[\d+]\.reveal\.hands\./.test(path),
        );
        expect(leaked, `${client.playerId} received ${message.type}`).toEqual([]);
        inspected += 1;
      }
      // And the hand it did see was its own.
      const you = client.snapshot?.view.you;
      expect(you?.id).toBe(client.playerId);
    }
    expect(inspected).toBeGreaterThan(50);
  });

  test('the server refuses a protocol version it cannot speak', async () => {
    const client = await TestClient.connect(url);
    clients.push(client);
    client.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION + 1 });
    const message = await client.waitFor((m) => m.type === 'updateRequired');
    expect(message).toMatchObject({
      type: 'updateRequired',
      serverProtocolVersion: PROTOCOL_VERSION,
    });
  });

  test('nothing but hello is accepted before hello', async () => {
    const client = await TestClient.connect(url);
    clients.push(client);
    client.send({ type: 'findMatch' });
    const message = await client.waitFor((m) => m.type === 'error');
    expect(message).toMatchObject({ type: 'error', code: 'HELLO_REQUIRED' });
  });

  test('an illegal bid comes back as a reason code, and the match carries on', async () => {
    const four = await seatFour();
    const onTurn = four.find((c) => c.isMyTurn);
    expect(onTurn).toBeDefined();
    if (onTurn?.matchId == null) return;

    // R-04: far more dice than exist on the table.
    onTurn.send({ type: 'bid', matchId: onTurn.matchId, bid: { quantity: 99, face: 6 } });
    const rejection = await onTurn.waitFor((m) => m.type === 'error');
    expect(rejection).toMatchObject({ code: 'BID_EXCEEDS_DICE_IN_PLAY' });

    // Still their turn, and a legal bid still works.
    expect(onTurn.isMyTurn).toBe(true);
    onTurn.send({ type: 'bid', matchId: onTurn.matchId, bid: { quantity: 1, face: 3 } });
    await onTurn.waitFor((m) => m.type === 'state' && m.events.some((e) => e.type === 'bidMade'));
  });

  test('a player cannot act out of turn', async () => {
    const four = await seatFour();
    const waiting = four.find((c) => !c.isMyTurn);
    expect(waiting).toBeDefined();
    if (waiting?.matchId == null) return;

    waiting.send({ type: 'bid', matchId: waiting.matchId, bid: { quantity: 1, face: 2 } });
    const rejection = await waiting.waitFor((m) => m.type === 'error');
    expect(rejection).toMatchObject({ code: 'NOT_YOUR_TURN' });
  });

  test('R-19: the match is abandoned once every client is gone', async () => {
    const four = await seatFour();
    expect(gateway.roomCount).toBe(1);
    for (const client of four) client.drop();
    await sleep(200);
    expect(gateway.roomCount).toBe(0);
  });
});
