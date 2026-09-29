import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ServerMessage } from '@liars-dice/protocol';
import { PROTOCOL_VERSION } from '@liars-dice/protocol';
import { Session, isCompleteCode, normaliseCode, type SocketLike } from '../src/session.ts';

/**
 * The browser client's state machine, without a browser.
 *
 * This is why `Session` takes its socket rather than building one: the whole path from a frame
 * arriving to the screen that should be showing is exercised here, with no renderer, no network,
 * and no DOM. The same seam the iOS client has for the same reason.
 */
class FakeSocket implements SocketLike {
  readyState = 1;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }

  // Overloads matching `SocketLike`, so the fake is checked against the real seam rather than
  // merely resembling it.
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
  addEventListener(type: string, listener: (event: never) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener as (event: unknown) => void);
    this.listeners.set(type, existing);
  }

  /** Pretend the server sent this. */
  deliver(message: ServerMessage): void {
    this.emit('message', { data: JSON.stringify(message) });
  }

  open(): void {
    this.emit('open');
  }

  /** A close arriving from the network, as opposed to one this client asked for. */
  fireClose(): void {
    this.readyState = 3;
    this.emit('close');
  }

  private emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** The parsed messages the client wrote. */
  messages(): { type: string; [key: string]: unknown }[] {
    return this.sent.map((frame) => JSON.parse(frame) as { type: string });
  }
}

function connected(): { session: Session; socket: FakeSocket } {
  const socket = new FakeSocket();
  const session = new Session('ws://test', () => socket);
  session.connect();
  socket.open();
  return { session, socket };
}

const welcome: ServerMessage = {
  type: 'welcome',
  protocolVersion: PROTOCOL_VERSION,
  playerId: 'me',
  token: 'tok',
};

const party = (hostId: string, members: string[]): ServerMessage => ({
  type: 'partyState',
  code: 'WXYZ',
  hostId,
  members,
  minSize: 2,
  maxSize: 6,
});

/** A `state` message carrying just enough of a snapshot for the timer tests. */
function state(options: {
  turnEndsInMs: number | null;
  turnId: string;
  phase?: { kind: 'reveal' };
}): ServerMessage {
  return {
    type: 'state',
    kind: 'update',
    matchId: 'm1',
    seq: 1,
    events: [],
    snapshot: {
      view: {
        matchId: 'm1',
        seq: 1,
        config: { startingDice: 5, maxDice: 5 },
        you: { id: 'me', seat: 0, dice: [1, 2, 3, 4, 5] },
        players: [{ id: 'me', seat: 0, diceCount: 5, eliminated: false }],
        phase: options.phase ?? { kind: 'bidding', turnId: options.turnId },
        round: { index: 0, starterId: 'me', bids: [] },
        lastReveal: null,
        totalDiceInPlay: 5,
      },
      turnEndsInMs: options.turnEndsInMs,
      turnMs: 30_000,
      seats: [],
      bidOptions: null,
    },
  };
}

describe('Party codes', () => {
  test('a typed code is cleaned up rather than refused', () => {
    // The wire contract is strict and uppercase. Being told "bad message" for typing lowercase
    // is indefensible, so the leniency lives here and the strictness stays on the wire.
    expect(normaliseCode('wxyz')).toBe('WXYZ');
    expect(normaliseCode('w x y z')).toBe('WXYZ');
    expect(normaliseCode('WX-YZ')).toBe('WXYZ');
    expect(normaliseCode('  wxyz  ')).toBe('WXYZ');
  });

  test('characters outside the alphabet are dropped, not guessed at', () => {
    // O/0 and I/1 are absent from the alphabet because they are misheard. Substituting a guess
    // would silently join the wrong game; dropping leaves the button disabled instead.
    expect(normaliseCode('W0XI')).toBe('WX');
    expect(isCompleteCode('W0XI')).toBe(false);
    expect(isCompleteCode('WXY')).toBe(false);
    expect(isCompleteCode('wxyz')).toBe(true);
  });

  test('overlong input is truncated to a code', () => {
    expect(normaliseCode('WXYZABCD')).toBe('WXYZ');
  });
});

describe('The session', () => {
  test('it introduces itself with the protocol version before anything else', () => {
    const { socket } = connected();
    const [hello] = socket.messages();
    expect(hello?.type).toBe('hello');
    expect(hello?.['protocolVersion']).toBe(PROTOCOL_VERSION);
  });

  test('a welcome lands in the lobby', () => {
    const { session, socket } = connected();
    socket.deliver(welcome);
    expect(session.getState().stage.kind).toBe('lobby');
    expect(session.getState().playerId).toBe('me');
  });

  test('a version mismatch asks the player to reload rather than guessing', () => {
    const { session, socket } = connected();
    socket.deliver({
      type: 'updateRequired',
      serverProtocolVersion: 99,
      minProtocolVersion: 99,
      message: 'newer',
    });
    expect(session.getState().stage).toEqual({ kind: 'needsUpdate', serverVersion: 99 });
  });

  test('joining sends the normalised code', () => {
    const { session, socket } = connected();
    socket.deliver(welcome);
    session.joinParty('w x y z');
    const join = socket.messages().find((message) => message.type === 'joinParty');
    expect(join?.['code']).toBe('WXYZ');
  });

  test('a party state becomes the party screen', () => {
    const { session, socket } = connected();
    socket.deliver(welcome);
    socket.deliver(party('me', ['me']));
    const { stage } = session.getState();
    expect(stage.kind).toBe('party');
    if (stage.kind === 'party') {
      expect(stage.party.code).toBe('WXYZ');
      expect(stage.party.hostId).toBe('me');
    }
  });

  test('the screen follows the host being passed on, rather than deciding locally', () => {
    const { session, socket } = connected();
    socket.deliver(welcome);
    socket.deliver(party('me', ['me', 'them']));
    socket.deliver(party('them', ['them']));
    const { stage } = session.getState();
    expect(stage.kind === 'party' && stage.party.hostId).toBe('them');
  });

  test('leaving a party returns to the lobby', () => {
    const { session, socket } = connected();
    socket.deliver(welcome);
    socket.deliver(party('me', ['me']));
    socket.deliver({ type: 'partyLeft' });
    expect(session.getState().stage.kind).toBe('lobby');
  });

  test('starting sends the bot choice through', () => {
    const { session, socket } = connected();
    socket.deliver(welcome);
    socket.deliver(party('me', ['me', 'them']));
    session.startParty(true);
    const start = socket.messages().find((message) => message.type === 'startParty');
    expect(start?.['fillWithBots']).toBe(true);
  });

  test('a match found moves to the table', () => {
    const { session, socket } = connected();
    socket.deliver(welcome);
    socket.deliver({ type: 'matchFound', matchId: 'm1', seats: [] });
    expect(session.getState().stage.kind).toBe('playing');
    expect(session.getState().matchId).toBe('m1');
  });

  test('a refusal is surfaced and does not move the player', () => {
    const { session, socket } = connected();
    socket.deliver(welcome);
    session.joinParty('ZZZZ');
    socket.deliver({ type: 'error', code: 'UNKNOWN_PARTY', detail: null });
    expect(session.getState().lastError).toBe('UNKNOWN_PARTY');
    expect(session.getState().stage.kind).toBe('lobby');
  });

  test('subscribers are told when anything changes', () => {
    const { session, socket } = connected();
    let notified = 0;
    const unsubscribe = session.subscribe(() => {
      notified += 1;
    });
    socket.deliver(welcome);
    expect(notified).toBeGreaterThan(0);
    unsubscribe();
    const before = notified;
    socket.deliver(party('me', ['me']));
    expect(notified).toBe(before);
  });

  test('R-16: a relative deadline becomes an absolute one the moment it lands', () => {
    // The server sends how long was left when it built the snapshot, never a timestamp — a
    // browser with a skewed clock would draw the wrong ring. Re-basing has to happen once, on
    // arrival; doing it per render would leave the countdown permanently stuck at full.
    const { session, socket } = connected();
    socket.deliver(welcome);
    const before = Date.now();
    socket.deliver(state({ turnEndsInMs: 30_000, turnId: 'me' }));
    const after = Date.now();

    const { turnDeadline } = session.getState();
    expect(turnDeadline).not.toBeNull();
    expect(turnDeadline).toBeGreaterThanOrEqual(before + 30_000);
    expect(turnDeadline).toBeLessThanOrEqual(after + 30_000);
  });

  test('R-16: no deadline on a bot turn, which gets a think delay instead', () => {
    const { session, socket } = connected();
    socket.deliver(welcome);
    socket.deliver(state({ turnEndsInMs: null, turnId: 'bot_1234' }));
    expect(session.getState().turnDeadline).toBeNull();
  });

  test('R-16: no deadline during a reveal, even if one is still reported', () => {
    // Belt and braces: the room clears `turnEndsAt` when it moves to a reveal, but a snapshot
    // built mid-transition must not leave a ring counting down over the revealed hands.
    const { session, socket } = connected();
    socket.deliver(welcome);
    socket.deliver(state({ turnEndsInMs: 12_000, turnId: 'me', phase: { kind: 'reveal' } }));
    expect(session.getState().turnDeadline).toBeNull();
  });

  test('leaving a match clears the deadline with everything else', () => {
    const { session, socket } = connected();
    socket.deliver(welcome);
    socket.deliver({ type: 'matchFound', matchId: 'm1', seats: [] });
    socket.deliver(state({ turnEndsInMs: 30_000, turnId: 'me' }));
    expect(session.getState().turnDeadline).not.toBeNull();
    session.leaveMatch();
    expect(session.getState().turnDeadline).toBeNull();
    expect(session.getState().snapshot).toBeNull();
  });

  test('a bid is not sent before there is a match to send it to', () => {
    // The picker cannot be on screen without a match, but a stale click during a transition
    // could still land here. A message with a missing matchId would be a protocol error.
    const { session, socket } = connected();
    socket.deliver(welcome);
    session.bid(3, 5);
    expect(socket.messages().some((message) => message.type === 'bid')).toBe(false);
  });
});

describe('Finding the server', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('in development the socket follows the host the page came from', async () => {
    // The bug this exists to prevent: a hardcoded 127.0.0.1 works on the machine running the dev
    // server and fails silently on every other device, because 127.0.0.1 on a phone is the phone.
    vi.stubGlobal('window', {
      location: { protocol: 'http:', hostname: '10.0.0.241', host: '10.0.0.241:5173' },
    });
    const { defaultEndpoint } = await import('../src/session.ts');
    expect(defaultEndpoint()).toBe('ws://10.0.0.241:8080');
  });

  test('on localhost it still points at localhost', async () => {
    vi.stubGlobal('window', {
      location: { protocol: 'http:', hostname: 'localhost', host: 'localhost:5173' },
    });
    const { defaultEndpoint } = await import('../src/session.ts');
    expect(defaultEndpoint()).toBe('ws://localhost:8080');
  });
});

describe('React StrictMode mounts the effect twice', () => {
  /**
   * In development React runs an effect, tears it down, and runs it again — deliberately, to
   * surface exactly this class of bug. The session must survive connect → disconnect → connect
   * with the *second* socket intact.
   */
  function strictMount(): { session: Session; sockets: FakeSocket[] } {
    const sockets: FakeSocket[] = [];
    const session = new Session('ws://test', () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    session.connect(); // mount
    session.disconnect(); // cleanup
    session.connect(); // mount again
    return { session, sockets };
  }

  test('a superseded socket closing does not discard the live one', () => {
    const { sockets } = strictMount();
    const [first, second] = sockets;
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    // The first socket's close event arrives *after* the second has been created — that is the
    // whole point of the race. It must not touch the session's current socket.
    first?.fireClose();
    second?.open();

    const hello = second?.messages().find((message) => message.type === 'hello');
    expect(hello, 'the live socket never sent its hello').toBeDefined();
  });

  test('a superseded socket closing does not strand the app on the failure screen', () => {
    const { session, sockets } = strictMount();
    const [first, second] = sockets;
    first?.fireClose();
    second?.open();
    second?.deliver(welcome);
    expect(session.getState().stage.kind).toBe('lobby');
  });

  test('a genuine disconnection is still reported', () => {
    // The guard must not swallow the case it exists to report: the socket actually in use going
    // away with nothing to resume.
    const { session, sockets } = strictMount();
    const second = sockets[1];
    second?.open();
    second?.deliver(welcome);
    expect(session.getState().stage.kind).toBe('lobby');
    second?.fireClose();
    expect(session.getState().stage.kind).toBe('failed');
  });
});

/**
 * Killing the connection mid-match.
 *
 * The backlog's word for what was missing here was "in anger": the backoff was written to mirror
 * the iOS client's and the banner was wired up, but nothing had ever dropped a live match and
 * watched what the client did next. These do that with a fake clock, which is the part a person
 * turning their wifi off cannot do — a five-second outage exercises one retry, and the failures
 * worth finding are in the fourth.
 */
describe('A connection that drops mid-match', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A session in a live match, and every socket it has opened. */
  function playing(): { session: Session; sockets: FakeSocket[] } {
    const sockets: FakeSocket[] = [];
    const session = new Session('ws://test', () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    session.connect();
    const first = sockets[0];
    if (first === undefined) throw new Error('no socket was opened');
    first.open();
    first.deliver(welcome);
    first.deliver({ type: 'matchFound', matchId: 'm1', seats: [] });
    first.deliver(atSeq(7));
    return { session, sockets };
  }

  const live = (sockets: FakeSocket[]): FakeSocket => {
    const socket = sockets.at(-1);
    if (socket === undefined) throw new Error('no socket was opened');
    return socket;
  };

  /** A `state` at a given sequence number, so a resume has something to ask from. */
  function atSeq(seq: number, kind: 'update' | 'sync' = 'update'): ServerMessage {
    const message = state({ turnEndsInMs: 30_000, turnId: 'me' });
    if (message.type !== 'state') throw new Error('not a state');
    return { ...message, kind, seq, snapshot: message.snapshot };
  }

  test('it reconnects, resumes from where it left off, and keeps the feed', () => {
    vi.useFakeTimers();
    const { session, sockets } = playing();
    const seen = session.getState().log.length;

    live(sockets).fireClose();
    expect(session.getState().reconnecting, 'no banner while the socket is gone').toBe(true);

    vi.advanceTimersByTime(0);
    expect(sockets.length, 'it never dialled again').toBe(2);
    const second = live(sockets);
    second.open();
    expect(second.messages().map((message) => message.type)).toContain('hello');

    second.deliver(welcome);
    // R-18: the server holds the seat, and the client asks for what it missed rather than for
    // the whole match. `afterSeq` is the last state it actually saw.
    const resume = second.messages().find((message) => message.type === 'resume');
    expect(resume?.['matchId']).toBe('m1');
    expect(resume?.['afterSeq']).toBe(7);

    second.deliver({ type: 'matchFound', matchId: 'm1', seats: [] });
    second.deliver(atSeq(9, 'sync'));

    expect(session.getState().reconnecting, 'the banner never came down').toBe(false);
    expect(session.getState().stage.kind).toBe('playing');
    expect(session.getState().matchId).toBe('m1');
    // A sync is a catch-up on things already read; replaying them would double the feed.
    expect(session.getState().log.length).toBe(seen);
  });

  test('the same match keeps its snapshot, rather than blanking to "Dealing…"', () => {
    vi.useFakeTimers();
    const { session, sockets } = playing();
    live(sockets).fireClose();
    vi.advanceTimersByTime(0);
    live(sockets).open();
    live(sockets).deliver(welcome);
    live(sockets).deliver({ type: 'matchFound', matchId: 'm1', seats: [] });
    // The re-announced match is the one already on screen, so the table must not be torn down
    // while the resync is in flight.
    expect(session.getState().snapshot).not.toBeNull();
  });

  test('a server that accepts and drops is backed off, not hammered', () => {
    // The failure a person cannot produce by hand: `node --watch` restarting on a file save, or
    // a server rolling, accepts the socket and drops it before saying welcome. Resetting the
    // backoff on `open` rather than on a working session means every retry looks like the first
    // one, and the client dials in a tight loop for as long as the server is down.
    vi.useFakeTimers();
    const { sockets } = playing();

    live(sockets).fireClose();
    vi.advanceTimersByTime(0);
    expect(sockets.length).toBe(2);
    live(sockets).open(); // accepted…
    live(sockets).fireClose(); // …and dropped, with no welcome in between.

    const dialled = sockets.length;
    vi.advanceTimersByTime(0);
    expect(sockets.length, 'it redialled with no delay at all').toBe(dialled);
    vi.advanceTimersByTime(500);
    expect(sockets.length, 'it never redialled').toBe(dialled + 1);
  });

  test('the backoff keeps growing while the server stays down', () => {
    vi.useFakeTimers();
    const { sockets } = playing();
    // Each entry is the wait *before* that attempt, mirroring the iOS client's ladder.
    for (const delay of [0, 500, 1_000, 2_000, 4_000, 4_000]) {
      const dialled = sockets.length;
      live(sockets).fireClose();
      if (delay > 0) {
        vi.advanceTimersByTime(delay - 1);
        expect(sockets.length, `redialled before ${String(delay)}ms`).toBe(dialled);
      }
      vi.advanceTimersByTime(1);
      expect(sockets.length, `never redialled after ${String(delay)}ms`).toBe(dialled + 1);
      live(sockets).open();
    }
  });

  test('a working session resets the ladder', () => {
    vi.useFakeTimers();
    const { sockets } = playing();
    live(sockets).fireClose();
    vi.advanceTimersByTime(0);
    live(sockets).open();
    live(sockets).fireClose();
    vi.advanceTimersByTime(500);
    live(sockets).open();
    live(sockets).deliver(welcome); // back in the match

    // The next outage is a fresh one and should be retried immediately, not after 1s.
    const dialled = sockets.length;
    live(sockets).fireClose();
    vi.advanceTimersByTime(0);
    expect(sockets.length, 'the ladder was not reset by a working connection').toBe(dialled + 1);
  });

  test('leaving while a retry is pending does not dial again afterwards', () => {
    // React unmounts the app on navigation and StrictMode does it on purpose in development.
    // A pending backoff timer that fires afterwards opens a socket nothing owns and nothing
    // will ever close.
    vi.useFakeTimers();
    const { session, sockets } = playing();
    live(sockets).fireClose();
    session.disconnect();
    vi.advanceTimersByTime(30_000);
    expect(sockets.length, 'a disconnected session reconnected itself').toBe(1);
  });

  test('a drop outside a match is not retried at all', () => {
    // Nothing is being held for them, so silently reconnecting would hide a dead server behind
    // a lobby that looks fine until the first button does nothing.
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const session = new Session('ws://test', () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    session.connect();
    live(sockets).open();
    live(sockets).deliver(welcome);
    live(sockets).fireClose();
    vi.advanceTimersByTime(30_000);
    expect(sockets.length).toBe(1);
    expect(session.getState().stage.kind).toBe('failed');
  });
});

/**
 * "Again, same people."
 *
 * The party outlives the match it started, so the end of a game is a fork rather than an exit.
 * What this client has to get right is knowing *whether* to offer it — a match found through
 * the queue has no party behind it — and not wandering off the table when a `partyState` turns
 * up for some other reason.
 */
describe('Playing again', () => {
  const matchFound: ServerMessage = { type: 'matchFound', matchId: 'm1', seats: [] };

  /** Through the party screen and into a match, the way friends get there. */
  function fromParty(): { session: Session; socket: FakeSocket } {
    const { session, socket } = connected();
    socket.deliver(welcome);
    socket.deliver(party('me', ['me', 'them']));
    socket.deliver(matchFound);
    return { session, socket };
  }

  test('a match started from a party remembers which one', () => {
    const { session } = fromParty();
    expect(session.getState().partyCode).toBe('WXYZ');
    expect(session.getState().stage.kind).toBe('playing');
  });

  test('a match found through the queue has nothing to go back to', () => {
    const { session, socket } = connected();
    socket.deliver(welcome);
    socket.deliver(matchFound);
    expect(session.getState().partyCode).toBeNull();
  });

  test('the code survives a reconnect, because this object does', () => {
    // The socket drops; the session does not. A re-announced match must not look like a new
    // one and quietly lose the rematch button.
    const { session, socket } = fromParty();
    socket.deliver(matchFound);
    expect(session.getState().partyCode).toBe('WXYZ');
  });

  test('asking to play again sends for the party', () => {
    const { session, socket } = fromParty();
    session.rematch();
    expect(socket.messages().at(-1)?.type).toBe('rematch');
  });

  test('there is nothing to ask for after a public match', () => {
    const { session, socket } = connected();
    socket.deliver(welcome);
    socket.deliver(matchFound);
    const before = socket.messages().length;
    session.rematch();
    expect(socket.messages().length, 'it asked for a party it never had').toBe(before);
  });

  test('the answer to "play again" is what moves the screen', () => {
    const { session, socket } = fromParty();
    session.rematch();
    socket.deliver(party('me', ['me', 'them']));
    const { stage } = session.getState();
    expect(stage.kind).toBe('party');
    expect(stage.kind === 'party' && stage.party.code).toBe('WXYZ');
  });

  test('a party update nobody asked for does not take the match off the screen', () => {
    // The server holds these back from a player who is at a table, so this is the gap between
    // a match ending and a button being pressed — someone else leaving the party in those few
    // seconds must not replace the final score with a lobby.
    const { session, socket } = fromParty();
    socket.deliver(party('me', ['me']));
    expect(session.getState().stage.kind).toBe('playing');
  });

  test('going back to the lobby gives up the party too', () => {
    const { session, socket } = fromParty();
    session.leaveMatch();
    expect(session.getState().partyCode).toBeNull();
    expect(socket.messages().some((message) => message.type === 'leave')).toBe(true);
    // And a stale refusal from the match just left does not follow them to the lobby.
    expect(session.getState().lastError).toBeNull();
  });
});
