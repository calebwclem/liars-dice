import { afterEach, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Face, ProtocolEvent, ServerMessage } from '@liars-dice/protocol';
import { PROTOCOL_VERSION } from '@liars-dice/protocol';
import { App } from '../../src/ui/App.tsx';
import { Session, type SocketLike } from '../../src/session.ts';

/**
 * The real stylesheet, in the document.
 *
 * happy-dom does no layout, so this cannot check that anything is the right *size*. It can
 * resolve the cascade, which is enough to catch a rule that does nothing — and "does nothing" is
 * precisely how the pips failed: `width` and `height` on an inline element are ignored, so they
 * were zero-sized rather than wrong-sized.
 *
 * Read off disk rather than imported: Vitest stubs CSS modules by default, and `?raw` came back
 * as an empty string — which would have made every assertion below pass against no stylesheet
 * at all. Vitest runs with the package root as its cwd.
 */
const THEME = readFileSync('src/ui/theme.css', 'utf8');

/**
 * The real component tree, mounted.
 *
 * Every other test in this package checks a piece: the state machine with a fake socket, a
 * component rendered to a string. Two bugs got past all of them and reached a phone, and both
 * lived in the wiring rather than in either half — a StrictMode double-mount discarding the live
 * socket, and dice drawn with a percentage padding that resolves against the wrong box.
 *
 * So this mounts `App` in `StrictMode`, exactly as `main.tsx` does, and drives it with a fake
 * socket. happy-dom does no layout, so it cannot catch *visual* faults; what it does catch is a
 * component that never renders, never connects, or renders the wrong thing.
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
    // Deferred, because a real WebSocket never fires `close` synchronously from `close()`. A
    // fake that did made the StrictMode race untestable: the first socket's close landed while
    // it was still the current one, and the guard it was meant to exercise never ran.
    queueMicrotask(() => {
      this.emit('close');
    });
  }

  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
  addEventListener(type: string, listener: (event: never) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener as (event: unknown) => void);
    this.listeners.set(type, existing);
  }

  open(): void {
    this.emit('open');
  }

  /** A close arriving from the network, rather than one this client asked for. */
  fireClose(): void {
    this.readyState = 3;
    this.emit('close');
  }

  deliver(message: ServerMessage): void {
    this.emit('message', { data: JSON.stringify(message) });
  }

  private emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  sentTypes(): string[] {
    return this.sent.map((frame) => (JSON.parse(frame) as { type: string }).type);
  }
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** Mount the app in StrictMode, as `main.tsx` does, and hand back the sockets it opened. */
async function mount(): Promise<{ sockets: FakeSocket[] }> {
  const sockets: FakeSocket[] = [];
  const session = new Session('ws://test', () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  const style = document.createElement('style');
  style.textContent = THEME;
  document.head.append(style);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <StrictMode>
        <App session={session} />
      </StrictMode>,
    );
    await Promise.resolve();
  });
  // Let StrictMode's teardown close land. This is the moment the bug used to happen.
  await act(async () => {
    await Promise.resolve();
  });
  return { sockets };
}

const text = (): string => host?.textContent ?? '';
const live = (sockets: FakeSocket[]): FakeSocket => {
  const socket = sockets.at(-1);
  if (socket === undefined) throw new Error('no socket was opened');
  return socket;
};

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
});

const welcome: ServerMessage = {
  type: 'welcome',
  protocolVersion: PROTOCOL_VERSION,
  playerId: 'me',
  token: 'tok',
};

function snapshot(options: {
  turnId: string;
  myDice: Face[];
  round?: number;
  events?: ProtocolEvent[];
  kind?: 'update' | 'sync';
  winnerId?: string;
}): ServerMessage {
  const onTurn = options.turnId === 'me' && options.winnerId === undefined;
  const index = options.round ?? 0;
  return {
    type: 'state',
    kind: options.kind ?? 'update',
    matchId: 'm1',
    seq: 1,
    events: options.events ?? [],
    snapshot: {
      view: {
        matchId: 'm1',
        seq: 1,
        config: { startingDice: 5, maxDice: 5 },
        you: { id: 'me', seat: 0, dice: options.myDice },
        players: [
          { id: 'me', seat: 0, diceCount: options.myDice.length, eliminated: false },
          { id: 'them', seat: 1, diceCount: 5, eliminated: false },
        ],
        phase:
          options.winnerId === undefined
            ? { kind: 'bidding', turnId: options.turnId }
            : { kind: 'ended', winnerId: options.winnerId },
        round: { index, starterId: 'me', bids: [] },
        lastReveal: null,
        totalDiceInPlay: options.myDice.length + 5,
      },
      turnEndsInMs: onTurn ? 30_000 : null,
      turnMs: 30_000,
      seats: [
        { playerId: 'me', seat: 0, connected: true, control: 'human', controlReason: null },
        { playerId: 'them', seat: 1, connected: true, control: 'human', controlReason: null },
      ],
      bidOptions: onTurn
        ? {
            options: [1, 2, 3, 4, 5, 6].map((face) => ({ face: face as Face, minQuantity: 1 })),
            maxQuantity: 10,
          }
        : null,
    },
  };
}

describe('The app, mounted', () => {
  test('it connects and reaches the lobby through a StrictMode double mount', async () => {
    // The exact failure that reached a phone: the first socket's close discarded the second,
    // the hello was never sent, and the app sat on "cannot reach the table" forever.
    const { sockets } = await mount();
    expect(sockets.length).toBeGreaterThanOrEqual(1);

    const socket = live(sockets);
    act(() => {
      socket.open();
    });
    expect(socket.sentTypes(), 'the live socket never sent its hello').toContain('hello');

    act(() => {
      socket.deliver(welcome);
    });
    expect(text()).toContain('Find a match');
    expect(text()).not.toContain('Cannot reach the table');
  });

  test('the lobby offers both ways into a game', async () => {
    const { sockets } = await mount();
    const socket = live(sockets);
    act(() => {
      socket.open();
      socket.deliver(welcome);
    });
    expect(text()).toContain('Play with friends');
    expect(text()).toContain('Join with a code');
  });

  test('a private game shows its code as separate characters', async () => {
    const { sockets } = await mount();
    const socket = live(sockets);
    act(() => {
      socket.open();
      socket.deliver(welcome);
      socket.deliver({
        type: 'partyState',
        code: 'WXYZ',
        hostId: 'me',
        members: ['me'],
        minSize: 2,
        maxSize: 6,
      });
    });
    const cells = host?.querySelectorAll('.code span') ?? [];
    expect([...cells].map((cell) => cell.textContent)).toEqual(['W', 'X', 'Y', 'Z']);
    expect(text()).toContain('Waiting for one more');
  });

  test('the host can choose to play without bots, and it reaches the wire', async () => {
    // The option always existed and the server always honoured it, but it was an unstyled
    // checkbox on a dark table and read as no option at all. These assertions are about it
    // being *visible and reachable*, which is the half that was broken.
    const { sockets } = await mount();
    const socket = live(sockets);
    act(() => {
      socket.open();
      socket.deliver(welcome);
      socket.deliver({
        type: 'partyState',
        code: 'WXYZ',
        hostId: 'me',
        members: ['me', 'them'],
        minSize: 2,
        maxSize: 6,
      });
    });

    const choices = [...(host?.querySelectorAll('.segmented button') ?? [])] as HTMLButtonElement[];
    expect(choices.map((button) => button.textContent)).toEqual([
      'Just us2 players',
      'Add botsfill the empty seats',
    ]);
    // Bots by default — a fuller table is the fuller game — but plainly a choice.
    expect(choices[1]?.getAttribute('aria-pressed')).toBe('true');

    act(() => {
      choices[0]?.click();
    });
    expect(choices[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(choices[1]?.getAttribute('aria-pressed')).toBe('false');

    const start = [...(host?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Start the match',
    );
    act(() => {
      start?.click();
    });
    const sent = socket.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
    const startParty = sent.find((message) => message['type'] === 'startParty');
    expect(startParty?.['fillWithBots'], 'the choice never reached the server').toBe(false);
  });

  test('a full party cannot ask for bots there is no room for', async () => {
    const { sockets } = await mount();
    const socket = live(sockets);
    act(() => {
      socket.open();
      socket.deliver(welcome);
      socket.deliver({
        type: 'partyState',
        code: 'WXYZ',
        hostId: 'me',
        members: ['me', 'b', 'c', 'd', 'e', 'f'],
        minSize: 2,
        maxSize: 6,
      });
    });
    const choices = [...(host?.querySelectorAll('.segmented button') ?? [])] as HTMLButtonElement[];
    expect(choices[1]?.disabled).toBe(true);
    expect(choices[1]?.textContent).toContain('table is full');
  });

  test("a guest is not offered the host's controls", async () => {
    const { sockets } = await mount();
    const socket = live(sockets);
    act(() => {
      socket.open();
      socket.deliver(welcome);
      socket.deliver({
        type: 'partyState',
        code: 'WXYZ',
        hostId: 'them',
        members: ['them', 'me'],
        minSize: 2,
        maxSize: 6,
      });
    });
    expect(host?.querySelector('.segmented')).toBeNull();
    expect(text()).toContain('Waiting for');
  });

  test('the table draws a hand, and every die actually has its pips', async () => {
    // happy-dom does no layout, so a die's *size* cannot be checked here. Its pips can — and a
    // missing pip is what a player actually sees, since a blank white square is not a die.
    const { sockets } = await mount();
    const socket = live(sockets);
    act(() => {
      socket.open();
      socket.deliver(welcome);
      socket.deliver(snapshot({ turnId: 'me', myDice: [1, 2, 3, 4, 5] }));
    });

    expect(text()).toContain('Round 1');
    expect(text()).toContain('ones are wild');

    const hand = [...(host?.querySelectorAll('[data-face]') ?? [])];
    const faces = hand.map((die) => die.getAttribute('data-face'));
    // Five in the hand plus six in the bid picker.
    expect(faces).toEqual(['1', '2', '3', '4', '5', '1', '2', '3', '4', '5', '6']);

    for (const die of hand) {
      const face = Number(die.getAttribute('data-face'));
      const pips = die.querySelectorAll('.pip');
      expect(pips.length, `a ${String(face)} drew no pips`).toBe(face);
      // A pip that is `display: inline` has no size at all — width and height simply do not
      // apply to a non-replaced inline element — so the die renders as a blank white square.
      for (const pip of pips) {
        expect(window.getComputedStyle(pip).display, 'a pip that cannot be sized').toBe('block');
      }
    }
  });

  test('a die sizes its own padding rather than inheriting a percentage', async () => {
    // The other bug that reached a phone. A percentage padding resolves against the containing
    // block's width, so a die in a wide row ballooned and its pip grid collapsed to nothing.
    const { sockets } = await mount();
    const socket = live(sockets);
    act(() => {
      socket.open();
      socket.deliver(welcome);
      socket.deliver(snapshot({ turnId: 'me', myDice: [6] }));
    });
    const die = host?.querySelector('[data-face]');
    const padding = (die as HTMLElement | null)?.style.padding ?? '';
    expect(padding).toMatch(/px$/);
    expect(padding).not.toContain('%');
  });

  test('a new round re-rolls the hand; a mid-round update does not', async () => {
    // What makes the roll replay is the dice being *new elements* — a CSS animation has no
    // imperative restart, so a remount is the whole mechanism. Asserting on the nodes is
    // therefore asserting on the animation: keep the keys stable across a round and the hand
    // silently redraws, which is exactly the bug this is here for.
    const { sockets } = await mount();
    const socket = live(sockets);
    act(() => {
      socket.open();
      socket.deliver(welcome);
      socket.deliver(snapshot({ turnId: 'me', myDice: [1, 2, 3, 4, 5], round: 0 }));
    });
    const rolled = (): Element[] => [...(host?.querySelectorAll('.hand .rolled') ?? [])];
    const first = rolled();
    expect(first.length, 'the hand drew no rolled dice').toBe(5);

    // Same round, new snapshot: a bid landed, the clock ticked. The roll must not rewind.
    act(() => {
      socket.deliver(snapshot({ turnId: 'them', myDice: [1, 2, 3, 4, 5], round: 0 }));
    });
    expect(rolled(), 'a mid-round update restarted the roll').toEqual(first);

    // A new round, dealt. Same faces on purpose — an identical hand still has to be seen to
    // be thrown, or a round that changes nothing does not read as a round at all.
    act(() => {
      socket.deliver(snapshot({ turnId: 'me', myDice: [1, 2, 3, 4, 5], round: 1 }));
    });
    const second = rolled();
    expect(second.length).toBe(5);
    for (const [index, die] of second.entries()) {
      expect(die, `die ${String(index)} was reused across a round`).not.toBe(first[index]);
    }
  });

  test('a rolled die is actually given the animation, staggered across the hand', async () => {
    // happy-dom does no layout, so it cannot see anything move. It resolves the cascade, which
    // catches the failure worth catching here: a rule that matches nothing, or an animation
    // naming keyframes that do not exist — both of which draw a perfectly still hand.
    const { sockets } = await mount();
    const socket = live(sockets);
    act(() => {
      socket.open();
      socket.deliver(welcome);
      socket.deliver(snapshot({ turnId: 'me', myDice: [1, 2, 3, 4, 5] }));
    });
    const dice = [...(host?.querySelectorAll('.hand .rolled') ?? [])] as HTMLElement[];

    const animation = window.getComputedStyle(dice[0] as Element).animation;
    expect(animation, '.rolled matched no rule at all').not.toBe('');
    const name = animation.split(' ')[0] ?? '';
    // Anchored on the brace, not a substring: `@keyframes roll-in-renamed` contains
    // `@keyframes roll-in`, so a `toContain` here passes against the very rename it is for.
    expect(THEME, `the animation names @keyframes ${name}, which is not defined`).toMatch(
      new RegExp(`@keyframes\\s+${name}\\s*\\{`),
    );

    // Each die lands after the one before it; all five at once is a redraw, not a roll.
    expect(dice.map((die) => die.style.animationDelay)).toEqual([
      '0ms',
      '60ms',
      '120ms',
      '180ms',
      '240ms',
    ]);
    // How far it falls scales with the die, so the same animation reads right at any size.
    expect(dice[0]?.style.getPropertyValue('--roll-lift')).toBe('-70px');
  });

  test('the feed is broken into rounds rather than one flat list', async () => {
    const { sockets } = await mount();
    const socket = live(sockets);
    act(() => {
      socket.open();
      socket.deliver(welcome);
      socket.deliver(
        snapshot({
          turnId: 'me',
          myDice: [1, 2, 3, 4, 5],
          events: [
            { type: 'roundStarted', index: 0, starterId: 'me', diceCounts: { me: 5 } },
            { type: 'bidMade', playerId: 'me', bid: { quantity: 2, face: 6 } },
            { type: 'roundStarted', index: 1, starterId: 'them', diceCounts: { me: 4 } },
          ],
        }),
      );
    });
    const separators = [...(host?.querySelectorAll('.feed-round') ?? [])].map(
      (row) => row.textContent,
    );
    expect(separators).toEqual(['Round 2', 'Round 1']);

    // Newest first in the DOM; `.feed` is column-reverse, so that is newest at the bottom.
    const feed = [...(host?.querySelectorAll('.feed > *') ?? [])].map((row) => row.textContent);
    expect(feed).toEqual([
      'Player them opens',
      'Round 2',
      'You bid 2 sixes',
      'You open',
      'Round 1',
    ]);
    // The separator says which round it is, so the line beneath it must not say it again.
    expect(feed).not.toContain('Round 1: You open');
  });

  test('a connection dropped mid-match shows the banner, then comes back to the table', async () => {
    // The backlog's "reconnect, tested in anger". The state machine's own tests cover the
    // ladder and the resume; this is the half that only shows up once React is mounting — that
    // the banner appears, that the table is not torn down while the resync is in flight, and
    // that the app does not end up on "cannot reach the table" with a match still running.
    const { sockets } = await mount();
    const first = live(sockets);
    // StrictMode has already mounted, torn down and remounted the effect, so this is not
    // necessarily the first socket in the list — count from here rather than from zero.
    const before = sockets.length;
    act(() => {
      first.open();
      first.deliver(welcome);
      first.deliver(snapshot({ turnId: 'me', myDice: [1, 2, 3, 4, 5] }));
    });
    expect(text()).toContain('Round 1');

    act(() => {
      first.fireClose();
    });
    expect(text(), 'nothing told the player the connection had gone').toContain('Reconnecting');
    // The match is still on screen underneath. Blanking it would read as the match being over.
    expect(text()).toContain('Round 1');

    // The first rung of the ladder is immediate, so one turn of the event loop is the wait.
    await act(async () => {
      await new Promise((settle) => setTimeout(settle, 0));
    });
    expect(sockets.length, 'it never dialled again').toBe(before + 1);

    const second = live(sockets);
    act(() => {
      second.open();
      second.deliver(welcome);
      second.deliver({ type: 'matchFound', matchId: 'm1', seats: [] });
      second.deliver(snapshot({ turnId: 'me', myDice: [1, 2, 3, 4, 5], kind: 'sync' }));
    });

    expect(text(), 'the banner never came down').not.toContain('Reconnecting');
    expect(text()).not.toContain('Cannot reach the table');
    expect(text()).toContain('Round 1');
    expect(text()).toContain('Your turn');
  });

  test('the end of a private game offers another one, and asks for it', async () => {
    // Tier 3's flagship, from the button's side. The match is over; the first thing anyone
    // wants after a game with friends is another one, so it is the primary button.
    const { sockets } = await mount();
    const socket = live(sockets);
    act(() => {
      socket.open();
      socket.deliver(welcome);
      socket.deliver({
        type: 'partyState',
        code: 'WXYZ',
        hostId: 'me',
        members: ['me', 'them'],
        minSize: 2,
        maxSize: 6,
      });
      socket.deliver(snapshot({ turnId: 'me', myDice: [1, 2, 3], winnerId: 'me' }));
    });

    expect(text()).toContain('You win.');
    const again = [...(host?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Play again',
    );
    expect(again, 'no way to play again').toBeDefined();
    expect(again?.className, 'playing again is the thing they want; make it the loud button').toBe(
      'primary',
    );
    expect(text()).toContain('Back to room WXYZ');

    act(() => {
      again?.click();
    });
    expect(socket.sentTypes(), 'the button asked for nothing').toContain('rematch');

    // And the answer puts them back in the room, ready to start again.
    act(() => {
      socket.deliver({
        type: 'partyState',
        code: 'WXYZ',
        hostId: 'me',
        members: ['me', 'them'],
        minSize: 2,
        maxSize: 6,
      });
    });
    expect(text()).toContain('ROOM CODE');
    expect(text()).toContain('Start the match');
  });

  test('the end of a public match offers only the lobby', async () => {
    // There is no "same people" to reassemble, and a button that explains itself by failing is
    // worse than no button.
    const { sockets } = await mount();
    const socket = live(sockets);
    act(() => {
      socket.open();
      socket.deliver(welcome);
      socket.deliver({ type: 'matchFound', matchId: 'm1', seats: [] });
      socket.deliver(snapshot({ turnId: 'them', myDice: [], winnerId: 'them' }));
    });
    const labels = [...(host?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
    expect(labels).not.toContain('Play again');
    expect(labels).toContain('Back to the lobby');
  });

  test('it is the turn row, not the picker, that says whose turn it is', async () => {
    const { sockets } = await mount();
    const socket = live(sockets);
    act(() => {
      socket.open();
      socket.deliver(welcome);
      socket.deliver(snapshot({ turnId: 'them', myDice: [1, 2, 3, 4, 5] }));
    });
    expect(text()).toContain('Waiting for');
    expect(text()).not.toContain('Your turn');
    // No picker when it is not your turn — the server sends no options either.
    expect(host?.querySelector('.face-picker')).toBeNull();
  });
});
