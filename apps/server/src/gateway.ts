/**
 * The WebSocket gateway: the only thing in the system that touches a socket.
 *
 * Its job is to be paranoid. Every inbound frame is size-capped, rate-limited, and parsed
 * against a Zod schema before anything else sees it, because clients are hostile by
 * assumption. Once a message is valid, the gateway does nothing with it except hand it to
 * the matchmaker or the room the player actually sits in — it holds no game state and makes
 * no rules decisions.
 *
 * It also owns the session-to-socket mapping, which is what makes reconnection work: a
 * player who comes back with the same token is re-bound to their seat, and the room replies
 * to their `resume` with a fresh snapshot (R-18).
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { PlayerId } from '@liars-dice/engine';
import type { ClientMessage, ErrorCode, ServerMessage } from '@liars-dice/protocol';
import {
  encodeServerMessage,
  MAX_MESSAGE_BYTES,
  MIN_PROTOCOL_VERSION,
  parseClientMessage,
  PROTOCOL_VERSION,
} from '@liars-dice/protocol';
import type { Auth } from './auth.ts';
import type { Clock } from './clock.ts';
import type { Config } from './env.ts';
import type { Logger } from './logger.ts';
import { Matchmaker } from './matchmaker.ts';
import { Parties } from './party.ts';
import { Room, type SeatSpec } from './room.ts';

/** Close the socket after this many refusals — a client ignoring the limit is not a client. */
const MAX_VIOLATIONS = 5;

interface Session {
  readonly socket: WebSocket;
  playerId: PlayerId | null;
  tokens: number;
  lastRefill: number;
  violations: number;
}

export interface GatewayOptions {
  readonly config: Config;
  readonly clock: Clock;
  readonly auth: Auth;
  readonly rng: () => number;
  readonly log: Logger;
  /** Pass an existing server (tests share one with an http listener); otherwise one is made. */
  readonly server?: WebSocketServer;
}

export class Gateway {
  private readonly options: GatewayOptions;
  private readonly log: Logger;
  private readonly wss: WebSocketServer;
  private readonly sessions = new Map<WebSocket, Session>();
  /** The live socket per player. A second connection for the same player replaces the first. */
  private readonly sockets = new Map<PlayerId, WebSocket>();
  private readonly rooms = new Map<string, Room>();
  private readonly playerRoom = new Map<PlayerId, string>();
  private readonly matchmaker: Matchmaker;
  private readonly parties: Parties;

  constructor(options: GatewayOptions) {
    this.options = options;
    this.log = options.log;
    this.wss = options.server ?? new WebSocketServer({ noServer: true });
    this.matchmaker = new Matchmaker({
      matchSize: options.config.MATCH_SIZE,
      backfillMs: options.config.QUEUE_BACKFILL_MS,
      clock: options.clock,
      log: options.log,
      onMatch: (matchId, seats) => {
        this.openRoom(matchId, seats);
      },
    });
    this.parties = new Parties({
      matchSize: options.config.MATCH_SIZE,
      log: options.log,
      onStart: (matchId, seats) => {
        this.openRoom(matchId, seats);
      },
      onChanged: (party) => {
        // The party has no sockets of its own; delivering its state is the gateway's job.
        for (const playerId of party.members) this.send(playerId, { type: 'partyState', ...party });
      },
    });
    this.wss.on('connection', (socket: WebSocket) => {
      this.onConnection(socket);
    });
  }

  get server(): WebSocketServer {
    return this.wss;
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  get partyCount(): number {
    return this.parties.size;
  }

  async close(): Promise<void> {
    for (const room of this.rooms.values()) room.dispose();
    this.rooms.clear();
    this.matchmaker.dispose();
    this.parties.dispose();
    for (const socket of this.sessions.keys()) socket.close(1001, 'server shutting down');
    await new Promise<void>((resolve) => {
      this.wss.close(() => {
        resolve();
      });
    });
  }

  // ─── connection lifecycle ───────────────────────────────────────────────────

  private onConnection(socket: WebSocket): void {
    const session: Session = {
      socket,
      playerId: null,
      tokens: this.options.config.RATE_LIMIT_BURST,
      lastRefill: this.options.clock.now(),
      violations: 0,
    };
    this.sessions.set(socket, session);
    this.log.debug('socket.opened', {});

    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      this.onMessage(session, data, isBinary);
    });
    socket.on('close', () => {
      this.onClose(session);
    });
    socket.on('error', (error: Error) => {
      this.log.warn('socket.error', { message: error.message });
    });
  }

  private onClose(session: Session): void {
    this.sessions.delete(session.socket);
    const { playerId } = session;
    if (playerId === null) return;
    // Only forget the mapping if this socket is still the current one: a reconnect that
    // replaced it will have already pointed the player at their new socket.
    if (this.sockets.get(playerId) === session.socket) {
      this.sockets.delete(playerId);
      this.matchmaker.remove(playerId);
      // A party is a waiting room, not a seat: dropping out of one costs nothing but the
      // code, and the remaining members are told. A *match* is different — R-18 holds the
      // seat open, which is what `onDisconnected` below is for.
      this.parties.leave(playerId);
      this.roomOf(playerId)?.onDisconnected(playerId); // R-18
    }
    this.log.debug('socket.closed', { playerId });
  }

  // ─── inbound ────────────────────────────────────────────────────────────────

  private onMessage(
    session: Session,
    data: Buffer | ArrayBuffer | Buffer[],
    isBinary: boolean,
  ): void {
    if (!this.spendToken(session)) return;

    const raw = Array.isArray(data)
      ? Buffer.concat(data)
      : data instanceof ArrayBuffer
        ? Buffer.from(data)
        : data;
    if (raw.byteLength > MAX_MESSAGE_BYTES) {
      this.reject(session, 'MESSAGE_TOO_LARGE', `limit is ${String(MAX_MESSAGE_BYTES)} bytes`);
      session.socket.close(1009, 'message too large');
      return;
    }
    if (isBinary) {
      this.reject(session, 'BAD_MESSAGE', 'expected text frames');
      return;
    }

    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.reject(session, parsed.code, parsed.code === 'BAD_MESSAGE' ? parsed.detail : null);
      return;
    }
    this.route(session, parsed.message);
  }

  private route(session: Session, message: ClientMessage): void {
    if (message.type === 'hello') {
      this.onHello(session, message.protocolVersion, message.token);
      return;
    }

    const { playerId } = session;
    if (playerId === null) {
      this.reject(session, 'HELLO_REQUIRED', 'send hello first');
      return;
    }

    switch (message.type) {
      case 'ping':
        this.send(playerId, { type: 'pong' });
        return;

      case 'findMatch': {
        if (this.playerRoom.has(playerId)) {
          this.reject(session, 'ALREADY_IN_MATCH', null);
          return;
        }
        if (this.parties.isInParty(playerId)) {
          this.reject(session, 'ALREADY_IN_PARTY', null);
          return;
        }
        const status = this.matchmaker.enqueue(playerId);
        if (status === null) {
          this.reject(session, 'ALREADY_QUEUED', null);
          return;
        }
        // A full queue opens the room inside `enqueue`, and matchFound has already gone out.
        if (!this.playerRoom.has(playerId)) this.send(playerId, { type: 'queued', ...status });
        return;
      }

      case 'cancelQueue':
        if (!this.matchmaker.remove(playerId)) {
          this.reject(session, 'NOT_QUEUED', null);
          return;
        }
        this.send(playerId, { type: 'queueCancelled' });
        return;

      case 'createParty':
      case 'joinParty': {
        // The three waiting places are mutually exclusive, and the checks read in the order a
        // player would hit them: already playing, already queued, already in a party (which
        // `Parties` answers itself, since it is the one that knows).
        if (this.playerRoom.has(playerId)) {
          this.reject(session, 'ALREADY_IN_MATCH', null);
          return;
        }
        if (this.matchmaker.isQueued(playerId)) {
          this.reject(session, 'ALREADY_QUEUED', null);
          return;
        }
        const result =
          message.type === 'createParty'
            ? this.parties.create(playerId)
            : this.parties.join(playerId, message.code);
        // A success has already gone out as `partyState` through `onChanged`.
        if (typeof result === 'string') this.reject(session, result, null);
        return;
      }

      case 'leaveParty':
        if (!this.parties.leave(playerId)) {
          this.reject(session, 'NOT_IN_PARTY', null);
          return;
        }
        this.send(playerId, { type: 'partyLeft' });
        return;

      case 'startParty': {
        const failure = this.parties.start(playerId, message.fillWithBots);
        // On success the party dissolved and `openRoom` has already sent `matchFound`.
        if (failure !== null) this.reject(session, failure, null);
        return;
      }

      case 'bid':
      case 'dudo': {
        const room = this.rooms.get(message.matchId);
        if (room === undefined) {
          this.reject(session, 'UNKNOWN_MATCH', null);
          return;
        }
        if (!room.has(playerId)) {
          this.reject(session, 'NOT_IN_MATCH', null);
          return;
        }
        const failure =
          message.type === 'bid'
            ? room.submit(playerId, { type: 'bid', bid: message.bid })
            : room.submit(playerId, { type: 'dudo' });
        // The engine's reason code goes back verbatim: the client gets to know *why*, and a
        // reason code is exactly what the protocol carries.
        if (failure !== null) this.reject(session, failure, null);
        return;
      }

      case 'resume': {
        const room = this.rooms.get(message.matchId);
        if (!room?.has(playerId)) {
          this.reject(session, 'UNKNOWN_MATCH', null);
          return;
        }
        // R-18: rebinding happens on hello; this is the resync half.
        room.onConnected(playerId);
        room.resume(playerId, message.afterSeq);
        return;
      }

      case 'leave': {
        const room = this.rooms.get(message.matchId);
        if (!room?.has(playerId)) {
          this.reject(session, 'UNKNOWN_MATCH', null);
          return;
        }
        room.onLeft(playerId);
        this.playerRoom.delete(playerId);
        return;
      }

      default: {
        const unreachable: never = message;
        return unreachable;
      }
    }
  }

  private onHello(session: Session, protocolVersion: number, token: string | undefined): void {
    if (protocolVersion < MIN_PROTOCOL_VERSION || protocolVersion > PROTOCOL_VERSION) {
      // PLAN.md: reject an incompatible version with "please update" rather than guessing.
      this.sendTo(session.socket, {
        type: 'updateRequired',
        serverProtocolVersion: PROTOCOL_VERSION,
        minProtocolVersion: MIN_PROTOCOL_VERSION,
        message: `this server speaks protocol ${String(PROTOCOL_VERSION)}`,
      });
      session.socket.close(1002, 'unsupported protocol version');
      return;
    }

    const identity = this.options.auth.authenticate(token);
    const { playerId } = identity;

    // A second connection for the same player supersedes the first — the usual shape of a
    // reconnect, where the old socket has not been noticed as dead yet.
    const previous = this.sockets.get(playerId);
    if (previous !== undefined && previous !== session.socket) {
      const stale = this.sessions.get(previous);
      if (stale !== undefined) stale.playerId = null;
      previous.close(1000, 'replaced by a newer connection');
    }

    session.playerId = playerId;
    this.sockets.set(playerId, session.socket);
    this.log.info('session.hello', { playerId, fresh: identity.fresh });

    this.sendTo(session.socket, {
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      playerId,
      token: identity.token,
    });

    // R-18: back inside an existing match. Tell the room they are here; the client asks for
    // the snapshot itself with `resume`, which is the contract the rule describes.
    const room = this.roomOf(playerId);
    if (room !== undefined) {
      this.sendTo(session.socket, {
        type: 'matchFound',
        matchId: room.matchId,
        seats: [...room.playerIds].map((id, index) => ({
          playerId: id,
          seat: index,
          connected: true,
          control: 'human' as const,
          controlReason: null,
        })),
      });
      room.onConnected(playerId);
    }
  }

  // ─── rooms ──────────────────────────────────────────────────────────────────

  private openRoom(matchId: string, seats: readonly SeatSpec[]): void {
    const room = Room.open({
      matchId,
      seats,
      timings: {
        turnMs: this.options.config.TURN_MS,
        reconnectGraceMs: this.options.config.RECONNECT_GRACE_MS,
        revealMs: this.options.config.REVEAL_MS,
        botThinkMs: this.options.config.BOT_THINK_MS,
      },
      clock: this.options.clock,
      rng: this.options.rng,
      log: this.options.log,
      send: (playerId, message) => {
        this.send(playerId, message);
      },
      onFinished: (finished) => {
        this.closeRoom(finished);
      },
    });

    if (typeof room === 'string') {
      // Seating the matchmaker produced is illegal (R-01). Nothing a client can fix.
      this.log.error('room.openFailed', { matchId, reason: room });
      for (const seat of seats) {
        this.send(seat.playerId, { type: 'error', code: 'INTERNAL', detail: room });
      }
      return;
    }

    this.rooms.set(matchId, room);
    for (const playerId of room.playerIds) this.playerRoom.set(playerId, matchId);
  }

  private closeRoom(room: Room): void {
    this.rooms.delete(room.matchId);
    for (const playerId of room.playerIds) {
      if (this.playerRoom.get(playerId) === room.matchId) this.playerRoom.delete(playerId);
    }
    this.log.info('room.closed', { matchId: room.matchId, status: room.currentStatus });
  }

  private roomOf(playerId: PlayerId): Room | undefined {
    const matchId = this.playerRoom.get(playerId);
    return matchId === undefined ? undefined : this.rooms.get(matchId);
  }

  // ─── outbound ───────────────────────────────────────────────────────────────

  /** Deliver to a player's current socket, or drop it. A disconnected player gets nothing. */
  private send(playerId: PlayerId, message: ServerMessage): void {
    const socket = this.sockets.get(playerId);
    if (socket === undefined) return;
    this.sendTo(socket, message);
  }

  private sendTo(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(encodeServerMessage(message));
  }

  private reject(session: Session, code: ErrorCode, detail: string | null): void {
    this.sendTo(session.socket, { type: 'error', code, detail });
  }

  /** Token bucket. Returns false when the message should be dropped. */
  private spendToken(session: Session): boolean {
    const { RATE_LIMIT_BURST, RATE_LIMIT_PER_SECOND } = this.options.config;
    const now = this.options.clock.now();
    const elapsed = Math.max(0, now - session.lastRefill);
    session.lastRefill = now;
    session.tokens = Math.min(
      RATE_LIMIT_BURST,
      session.tokens + (elapsed / 1_000) * RATE_LIMIT_PER_SECOND,
    );

    if (session.tokens < 1) {
      session.violations += 1;
      this.reject(session, 'RATE_LIMITED', null);
      if (session.violations >= MAX_VIOLATIONS) {
        this.log.warn('socket.rateLimited', { playerId: session.playerId });
        session.socket.close(1008, 'rate limit exceeded');
      }
      return false;
    }
    session.tokens -= 1;
    return true;
  }
}
