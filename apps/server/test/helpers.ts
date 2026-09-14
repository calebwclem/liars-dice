import { makeRng } from '@liars-dice/engine';
import type { PlayerId } from '@liars-dice/engine';
import type { ServerMessage } from '@liars-dice/protocol';
import type { Clock, TimerHandle } from '../src/clock.ts';
import { silentLogger } from '../src/logger.ts';
import { Room, type RoomTimings, type SeatSpec } from '../src/room.ts';

export interface FakeClock extends Clock {
  /** Run every timer due within `ms`, in time order, including ones they schedule. */
  advance(ms: number): void;
  pending(): number;
}

/**
 * R-16 is a 30-second rule and R-18 is a 45-second one. A test that waits those out in real
 * time is a test nobody runs, so the server takes its clock as an argument and this stands in
 * for it — the same trick that makes the engine's `ctx.now` testable.
 */
export function fakeClock(start = 1_700_000_000_000): FakeClock {
  let current = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();

  return {
    now: () => current,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: current + ms, fn });
      return { id };
    },
    clearTimeout(handle: TimerHandle | null) {
      if (handle !== null) timers.delete(handle.id);
    },
    advance(ms) {
      const target = current + ms;
      for (;;) {
        let dueId: number | null = null;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < dueAt) {
            dueId = id;
            dueAt = timer.at;
          }
        }
        if (dueId === null) break;
        const timer = timers.get(dueId);
        timers.delete(dueId);
        if (timer === undefined) continue;
        current = timer.at;
        timer.fn();
      }
      current = target;
    },
    pending: () => timers.size,
  };
}

export const TEST_TIMINGS: RoomTimings = {
  turnMs: 30_000, // R-16
  reconnectGraceMs: 45_000, // R-18
  revealMs: 3_500,
  botThinkMs: 700,
};

export interface Sent {
  readonly playerId: PlayerId;
  readonly message: ServerMessage;
}

export interface Harness {
  readonly room: Room;
  readonly clock: FakeClock;
  readonly sent: Sent[];
  /** Everything a given player was sent. */
  to(playerId: PlayerId): readonly ServerMessage[];
  /** Every state message, in order, for one player. */
  states(playerId: PlayerId): readonly Extract<ServerMessage, { type: 'state' }>[];
  /** The latest snapshot a player holds. */
  latest(playerId: PlayerId): Extract<ServerMessage, { type: 'state' }>;
  /** Every event delivered to a player, flattened. */
  events(playerId: PlayerId): readonly { type: string }[];
  finished: Room | null;
}

/** Open a room with a recording transport and a fake clock. */
export function openRoom(options?: {
  seats?: readonly SeatSpec[];
  seed?: number;
  timings?: Partial<RoomTimings>;
}): Harness {
  const seats: readonly SeatSpec[] =
    options?.seats ??
    (['a', 'b', 'c', 'd'] as const).map((playerId) => ({ playerId, kind: 'human' as const }));
  const clock = fakeClock();
  const sent: Sent[] = [];
  const harness: Partial<Harness> & { sent: Sent[]; clock: FakeClock; finished: Room | null } = {
    clock,
    sent,
    finished: null,
  };

  const room = Room.open({
    matchId: 'M1',
    seats,
    timings: { ...TEST_TIMINGS, ...options?.timings },
    clock,
    rng: makeRng(options?.seed ?? 7),
    log: silentLogger(),
    send: (playerId, message) => {
      sent.push({ playerId, message });
    },
    onFinished: (room_) => {
      harness.finished = room_;
    },
  });
  if (typeof room === 'string') throw new Error(`room failed to open: ${room}`);

  const states = (playerId: PlayerId) =>
    sent
      .filter((entry) => entry.playerId === playerId && entry.message.type === 'state')
      .map((entry) => entry.message as Extract<ServerMessage, { type: 'state' }>);

  return {
    room,
    clock,
    sent,
    to: (playerId) => sent.filter((e) => e.playerId === playerId).map((e) => e.message),
    states,
    latest: (playerId) => {
      const all = states(playerId);
      const last = all[all.length - 1];
      if (last === undefined) throw new Error(`no state message for ${playerId}`);
      return last;
    },
    events: (playerId) => states(playerId).flatMap((message) => [...message.events]),
    get finished() {
      return harness.finished;
    },
  };
}

/** Whoever the engine says is on turn. */
export function onTurn(room: Room): PlayerId {
  const { phase } = room.debugState;
  if (phase.kind !== 'bidding') throw new Error(`not bidding: ${phase.kind}`);
  return phase.turnId;
}
