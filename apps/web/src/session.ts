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
  /**
   * The code of the private game this match came from, or null for a public one.
   *
   * What it is for is knowing whether to offer "play again": a party outlives the match it
   * starts, a matchmaker queue has nothing to go back to. Worked out from what this client
   * already saw rather than from anything on the wire — see version.ts for why a new field on
   * a server message would have been the more expensive answer.
   *
   * It survives a reconnect, because the socket drops and this object does not. It does not
   * survive a page reload mid-match, so a player who refreshes loses the button; they can
   * still rejoin by code, and paying a protocol change for that case is not worth it.
   */
  readonly partyCode: string | null;
}

const TOKEN_KEY = 'liarsdice.guestToken';
/**
 * How long to wait before each reconnection attempt. The first is immediate — most drops are a
 * blip and the seat is only held for 45 seconds (R-18) — and it settles at four seconds, which
 * is frequent enough to catch a server coming back and slow enough not to be a flood.
 */
const BACKOFF_MS = [0, 500, 1_000, 2_000, 4_000] as const;
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

/** The game server's port in development. Vite serves the page on 5173; this is next door. */
const DEV_SERVER_PORT = 8080;

/**
 * Where the server is.
 *
 * In production the page is served by the same Node process that owns the socket, so the origin
 * is the answer and there is no configuration to get wrong.
 *
 * In `vite dev` the page comes from :5173 and the server is on :8080 — but on the *same host the
 * page came from*, never a hardcoded localhost. Vite's dev server answers on the LAN so the
 * layout can be checked on a phone, and a phone told to connect to 127.0.0.1 would be connecting
 * to itself: the page loads and the socket silently has nowhere to go.
 */
export function defaultEndpoint(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (import.meta.env.DEV) {
    return `${scheme}//${window.location.hostname}:${String(DEV_SERVER_PORT)}`;
  }
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
    partyCode: null,
  };

  private readonly listeners = new Set<() => void>();
  private socket: SocketLike | null = null;
  private readonly endpoint: string;
  /** Set while a match is live, so a reconnect knows what to ask for (R-18). */
  private resumable: { matchId: string; afterSeq: number } | null = null;
  private attempt = 0;
  private closing = false;
  /** Set by `rematch`, so the `partyState` it asks for is the one that changes the screen. */
  private wantsParty = false;
  /** The pending backoff timer, so leaving can cancel it. */
  private retry: ReturnType<typeof setTimeout> | null = null;

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
    this.clearRetry();
    const socket = this.makeSocket(this.endpoint);
    this.socket = socket;

    // Every handler below checks that this socket is still the one in use before touching any
    // shared state. Without that guard a superseded socket's events act on its replacement:
    // React's StrictMode mounts an effect, tears it down and mounts it again, so the very first
    // thing that happens in development is connect → disconnect → connect, and the first
    // socket's `close` lands *after* the second exists. It would null out the live socket, the
    // hello would never be sent, no welcome would ever come back, and the app would sit on
    // "cannot reach the table" forever. The server's gateway guards its socket map the same way
    // and for the same reason.
    const current = (): boolean => this.socket === socket;

    socket.addEventListener('open', () => {
      if (!current()) return;
      // Note what is *not* reset here: the backoff. An open socket is not yet a working session
      // — see the `welcome` case, which is where the ladder goes back to the bottom.
      const token = readToken();
      this.send({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        ...(token === null ? {} : { token }),
      });
    });

    socket.addEventListener('message', (event: { data: string }) => {
      if (!current()) return;
      // Parsed against the same Zod schema the server validates with. The browser gets this for
      // free by importing the protocol package; the Swift client needed a code generator to
      // reach a weaker version of it.
      const parsed = ServerMessageSchema.safeParse(JSON.parse(event.data));
      if (parsed.success) this.handle(parsed.data);
    });

    socket.addEventListener('close', () => {
      if (!current()) return;
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
      const delay = BACKOFF_MS[this.attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? 4_000;
      this.attempt += 1;
      this.retry = setTimeout(() => {
        this.retry = null;
        // The view can go away during the wait — a navigation, or StrictMode tearing the effect
        // down. Without this check the timer opens a socket that nothing owns and nothing will
        // close, and `connect` would clear `closing` on its way past.
        if (this.closing) return;
        this.connect();
      }, delay);
    });

    socket.addEventListener('error', () => {
      // `close` always follows, and it is the one that knows whether to retry.
    });
  }

  disconnect(): void {
    this.closing = true;
    this.clearRetry();
    this.socket?.close();
    this.socket = null;
  }

  private clearRetry(): void {
    if (this.retry === null) return;
    clearTimeout(this.retry);
    this.retry = null;
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
    this.wantsParty = false;
    this.set({
      stage: { kind: 'lobby' },
      matchId: null,
      snapshot: null,
      turnDeadline: null,
      log: [],
      lastError: null,
      partyCode: null,
    });
  }

  /**
   * "Again, same people."
   *
   * The party outlived the match, so this asks the server to put it back on screen; the answer
   * is a `partyState`, and the host starts the next match from there. The flag is what tells
   * the `partyState` handler that *this* one is a navigation — see the note there.
   */
  rematch(): void {
    if (this.state.partyCode === null) return;
    this.wantsParty = true;
    this.set({ lastError: null });
    this.send({ type: 'rematch' });
  }

  // ─── inbound ────────────────────────────────────────────────────────────────

  private handle(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome': {
        writeToken(message.token);
        // *Here* is where the backoff goes back to the bottom. Resetting it when the socket
        // opened instead meant a server that accepts a connection and drops it before saying
        // anything — one restarting under `node --watch`, or a deploy rolling — was retried
        // every attempt at the first rung, which is no delay at all, for as long as it was down.
        this.attempt = 0;
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
        // A party update arriving while a match is on screen is news, not a navigation. The
        // server already declines to send one to a player who is at a table, so in practice
        // this is the gap between a match ending and the player pressing a button — someone
        // else leaving the party in those few seconds should not take the final score off
        // their screen. Only the `partyState` that `rematch` asked for moves them.
        if (this.state.stage.kind === 'playing' && !this.wantsParty) return;
        this.wantsParty = false;
        this.set({ stage: { kind: 'party', party: message }, partyCode: message.code });
        return;

      case 'partyLeft':
        this.set({ stage: { kind: 'lobby' }, partyCode: null });
        return;

      case 'matchFound':
        // A reconnect re-announces the match; keep the feed the player has already read.
        this.resumable = { matchId: message.matchId, afterSeq: 0 };
        this.set({
          stage: { kind: 'playing' },
          matchId: message.matchId,
          // Which party this came from, if any — the answer to "can we play again". A match
          // reached through the queue clears it; one started from the party screen keeps the
          // code that screen was showing.
          ...(this.state.stage.kind === 'party'
            ? { partyCode: this.state.stage.party.code }
            : this.state.matchId === message.matchId
              ? {}
              : { partyCode: null }),
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
