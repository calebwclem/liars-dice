import { describe, expect, test } from 'vitest';
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

  test('a bid is not sent before there is a match to send it to', () => {
    // The picker cannot be on screen without a match, but a stale click during a transition
    // could still land here. A message with a missing matchId would be a protocol error.
    const { session, socket } = connected();
    socket.deliver(welcome);
    session.bid(3, 5);
    expect(socket.messages().some((message) => message.type === 'bid')).toBe(false);
  });
});
