/**
 * The whole client, minus the pixels.
 *
 * This is the browser's counterpart to the iOS `GameSession` + `MatchViewModel`: it owns the
 * socket, the stage the app is in, and the latest snapshot. There is deliberately no React in
 * this file. Two reasons — it makes the state machine testable without a renderer, and if a
 * third client ever needs the same logic, moving this into `packages/client-core` is a move
 * rather than a rewrite. (See PLAN.md: don't build that abstraction from one example.)
 *
 * It holds no rules. Which bids are legal comes from `snapshot.bidOptions`, computed by the
 * engine on the server — the browser only decides which buttons to grey out.
 */
import type {
  ClientMessage,
  ErrorCode,
  MatchSnapshot,
  ProtocolEvent,
  ServerMessage,
} from '@liars-dice/protocol';
import {
  PARTY_CODE_ALPHABET,
  PARTY_CODE_LENGTH,
  PROTOCOL_VERSION,
  ServerMessageSchema,
} from '@liars-dice/protocol';

export type PartyState = Extract<ServerMessage, { type: 'partyState' }>;

export type Stage =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'lobby' }
  | { readonly kind: 'queued'; readonly waiting: number; readonly target: number }
  | { readonly kind: 'party'; readonly party: PartyState }
  | { readonly kind: 'playing' }
  | { readonly kind: 'needsUpdate'; readonly serverVersion: number }
  | { readonly kind: 'failed'; readonly reason: string };

export interface SessionState {
  readonly stage: Stage;
  readonly playerId: string | null;
  readonly matchId: string | null;
  readonly snapshot: MatchSnapshot | null;
  /**
   * R-16: when the current turn runs out, on *this* machine's clock, or null when nobody is on
   * it — during a reveal, or on a bot's turn, which gets a think delay instead of a deadline.
   *
   * Computed here rather than in the view because the server sends a *relative* figure: how long
   * was left when it built the snapshot. Turning that into an absolute moment has to happen the
   * instant the message lands, or every render re-bases the countdown and the ring never moves.
   */
  readonly turnDeadline: number | null;
  readonly log: readonly ProtocolEvent[];
  readonly lastError: ErrorCode | null;
  readonly reconnecting: boolean;
}

const TOKEN_KEY = 'liarsdice.guestToken';
/** Events kept for the feed. Enough to see the round, not enough to leak memory over an hour. */
const LOG_LIMIT = 60;

/** Uppercased, with anything outside the code alphabet dropped. */
export function normaliseCode(code: string): string {
  return [...code.toUpperCase()]
    .filter((character) => PARTY_CODE_ALPHABET.includes(character))
    .slice(0, PARTY_CODE_LENGTH)
    .join('');
}

export function isCompleteCode(code: string): boolean {
  return normaliseCode(code).length === PARTY_CODE_LENGTH;
}

/**
 * Where the server is.
 *
 * In production the page is served by the same Node process that owns the socket, so the origin
 * is the answer and no configuration exists to get wrong. In `vite dev` the page comes from
 * :5173 and the server is next door on :8080.
 */
export function defaultEndpoint(): string {
  if (import.meta.env.DEV) return 'ws://127.0.0.1:8080';
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}`;
}

/** The slice of `WebSocket` this uses. A seam, so tests can drive the state machine directly. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
  readyState: number;
}

export class Session {
  private state: SessionState = {
    stage: { kind: 'connecting' },
    playerId: null,
    matchId: null,
    snapshot: null,
    turnDeadline: null,
    log: [],
    lastError: null,
    reconnecting: false,
  };

  private readonly listeners = new Set<() => void>();
  private socket: SocketLike | null = null;
  private readonly endpoint: string;
  /** Set while a match is live, so a reconnect knows what to ask for (R-18). */
  private resumable: { matchId: string; afterSeq: number } | null = null;
  private attempt = 0;
  private closing = false;

  private readonly makeSocket: (url: string) => SocketLike;

  constructor(
    endpoint: string = defaultEndpoint(),
    makeSocket: (url: string) => SocketLike = (url) => new WebSocket(url),
  ) {
    this.endpoint = endpoint;
    this.makeSocket = makeSocket;
  }

  // ─── the store half ─────────────────────────────────────────────────────────

  getState = (): SessionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  // ─── connection ─────────────────────────────────────────────────────────────

  connect(): void {
    this.closing = false;
    const socket = this.makeSocket(this.endpoint);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempt = 0;
      const token = readToken();
      this.send({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        ...(token === null ? {} : { token }),
      });
    });

    socket.addEventListener('message', (event: { data: string }) => {
      // Parsed against the same Zod schema the server validates with. The browser gets this for
      // free by importing the protocol package; the Swift client needed a code generator to
      // reach a weaker version of it.
      const parsed = ServerMessageSchema.safeParse(JSON.parse(event.data));
      if (parsed.success) this.handle(parsed.data);
    });

    socket.addEventListener('close', () => {
      this.socket = null;
      if (this.closing) return;
      if (this.resumable === null) {
        if (this.state.stage.kind !== 'needsUpdate') {
          this.set({ stage: { kind: 'failed', reason: 'the connection closed' } });
        }
        return;
      }
      // R-18: the server holds the seat for 45 seconds. There is time, but not a lot of it.
      this.set({ reconnecting: true });
      const delay = [0, 500, 1_000, 2_000, 4_000][this.attempt] ?? 4_000;
      this.attempt += 1;
      setTimeout(() => {
        this.connect();
      }, delay);
    });

    socket.addEventListener('error', () => {
      // `close` always follows, and it is the one that knows whether to retry.
    });
  }

  disconnect(): void {
    this.closing = true;
    this.socket?.close();
    this.socket = null;
  }

  private send(message: ClientMessage): void {
    // 1 is OPEN. Spelled out rather than `WebSocket.OPEN` so this file does not need a browser
    // global to exist, which is what lets the state machine run under a plain test runner.
    if (this.socket?.readyState !== 1) return;
    this.socket.send(JSON.stringify(message));
  }

  // ─── intents ────────────────────────────────────────────────────────────────

  findMatch(): void {
    this.set({ lastError: null });
    this.send({ type: 'findMatch' });
  }

  cancelQueue(): void {
    this.send({ type: 'cancelQueue' });
  }

  createParty(): void {
    this.set({ lastError: null });
    this.send({ type: 'createParty' });
  }

  joinParty(code: string): void {
    this.set({ lastError: null });
    this.send({ type: 'joinParty', code: normaliseCode(code) });
  }

  leaveParty(): void {
    this.send({ type: 'leaveParty' });
  }

  startParty(fillWithBots: boolean): void {
    this.set({ lastError: null });
    this.send({ type: 'startParty', fillWithBots });
  }

  bid(quantity: number, face: number): void {
    const { matchId } = this.state;
    if (matchId === null) return;
    this.set({ lastError: null });
    // The face is a 1–6 literal in the schema; the picker only ever produces one.
    this.send({ type: 'bid', matchId, bid: { quantity, face: face as 1 | 2 | 3 | 4 | 5 | 6 } });
  }

  challenge(): void {
    const { matchId } = this.state;
    if (matchId === null) return;
    this.set({ lastError: null });
    this.send({ type: 'dudo', matchId });
  }

  leaveMatch(): void {
    const { matchId } = this.state;
    if (matchId !== null) this.send({ type: 'leave', matchId });
    this.resumable = null;
    this.set({
      stage: { kind: 'lobby' },
      matchId: null,
      snapshot: null,
      turnDeadline: null,
      log: [],
    });
  }

  // ─── inbound ────────────────────────────────────────────────────────────────

  private handle(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome': {
        writeToken(message.token);
        this.set({ playerId: message.playerId, reconnecting: false });
        if (this.resumable !== null) {
          this.send({
            type: 'resume',
            matchId: this.resumable.matchId,
            afterSeq: this.resumable.afterSeq,
          });
          this.set({ stage: { kind: 'playing' } });
        } else {
          this.set({ stage: { kind: 'lobby' } });
        }
        return;
      }

      case 'updateRequired':
        this.set({ stage: { kind: 'needsUpdate', serverVersion: message.serverProtocolVersion } });
        return;

      case 'queued':
        this.set({
          stage: { kind: 'queued', waiting: message.waiting, target: message.target },
        });
        return;

      case 'queueCancelled':
        this.set({ stage: { kind: 'lobby' } });
        return;

      case 'partyState':
        this.set({ stage: { kind: 'party', party: message } });
        return;

      case 'partyLeft':
        this.set({ stage: { kind: 'lobby' } });
        return;

      case 'matchFound':
        // A reconnect re-announces the match; keep the feed the player has already read.
        this.resumable = { matchId: message.matchId, afterSeq: 0 };
        this.set({
          stage: { kind: 'playing' },
          matchId: message.matchId,
          ...(this.state.matchId === message.matchId
            ? {}
            : { snapshot: null, turnDeadline: null, log: [] }),
        });
        return;

      case 'state': {
        this.resumable = { matchId: message.matchId, afterSeq: message.seq };
        const { turnEndsInMs } = message.snapshot;
        // Only a human seat gets a deadline; the server sends null for bots and for reveals.
        const onClock = turnEndsInMs !== null && message.snapshot.view.phase.kind === 'bidding';
        this.set({
          stage: { kind: 'playing' },
          matchId: message.matchId,
          snapshot: message.snapshot,
          turnDeadline: onClock ? Date.now() + turnEndsInMs : null,
          // `sync` is a catch-up after a reconnect; its events have mostly been seen already.
          log:
            message.kind === 'sync'
              ? this.state.log
              : [...this.state.log, ...message.events].slice(-LOG_LIMIT),
          lastError: null,
        });
        if (message.snapshot.view.phase.kind === 'ended') this.resumable = null;
        return;
      }

      case 'error':
        this.set({ lastError: message.code });
        return;

      case 'pong':
        return;

      default: {
        const unreachable: never = message;
        return unreachable;
      }
    }
  }
}

function readToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    // Private browsing can refuse storage entirely. A guest identity that lasts one session is
    // worse than one that persists, but far better than a client that cannot connect at all.
    return null;
  }
}

function writeToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* see readToken */
  }
}
