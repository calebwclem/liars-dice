/**
 * Matchmaking, as simple as PLAN.md asks for: a FIFO queue, fill to `matchSize`, and if the
 * player at the front has been waiting longer than `backfillMs`, start anyway with bots in
 * the empty seats.
 *
 * In memory, single instance. Redis arrives when there is a second machine and a socket
 * needs routing to the room that holds it — see docs/DECISIONS.md. Until then a Map and an
 * array are the whole implementation, and there is no second system to be wrong.
 */
import { randomUUID } from 'node:crypto';
import type { PlayerId } from '@liars-dice/engine';
import type { Clock, TimerHandle } from './clock.ts';
import type { Logger } from './logger.ts';
import type { SeatSpec } from './room.ts';

export interface MatchmakerOptions {
  readonly matchSize: number;
  readonly backfillMs: number;
  readonly clock: Clock;
  readonly log: Logger;
  /** Called with the seating once a match is ready to open. */
  readonly onMatch: (matchId: string, seats: readonly SeatSpec[]) => void;
  readonly newMatchId?: () => string;
}

export interface QueueStatus {
  readonly waiting: number;
  readonly target: number;
  readonly backfillInMs: number;
}

interface Waiting {
  readonly playerId: PlayerId;
  readonly since: number;
}

export class Matchmaker {
  private readonly options: MatchmakerOptions;
  private readonly queue: Waiting[] = [];
  private backfillTimer: TimerHandle | null = null;
  private readonly newMatchId: () => string;

  constructor(options: MatchmakerOptions) {
    this.options = options;
    this.newMatchId = options.newMatchId ?? (() => `m_${randomUUID()}`);
  }

  get waiting(): number {
    return this.queue.length;
  }

  isQueued(playerId: PlayerId): boolean {
    return this.queue.some((entry) => entry.playerId === playerId);
  }

  /** Returns the queue status to report back, or null if they were already in line. */
  enqueue(playerId: PlayerId): QueueStatus | null {
    if (this.isQueued(playerId)) return null;
    this.queue.push({ playerId, since: this.options.clock.now() });
    this.options.log.debug('queue.joined', { playerId, waiting: this.queue.length });

    if (this.queue.length >= this.options.matchSize) {
      this.startFrom(this.queue.splice(0, this.options.matchSize));
      return { waiting: 0, target: this.options.matchSize, backfillInMs: 0 };
    }
    this.armBackfill();
    return this.status();
  }

  remove(playerId: PlayerId): boolean {
    const at = this.queue.findIndex((entry) => entry.playerId === playerId);
    if (at === -1) return false;
    this.queue.splice(at, 1);
    this.options.log.debug('queue.left', { playerId, waiting: this.queue.length });
    if (this.queue.length === 0) {
      this.options.clock.clearTimeout(this.backfillTimer);
      this.backfillTimer = null;
    }
    return true;
  }

  status(): QueueStatus {
    const head = this.queue[0];
    const waited = head === undefined ? 0 : this.options.clock.now() - head.since;
    return {
      waiting: Math.max(1, this.queue.length),
      target: this.options.matchSize,
      backfillInMs: Math.max(0, this.options.backfillMs - waited),
    };
  }

  dispose(): void {
    this.options.clock.clearTimeout(this.backfillTimer);
    this.backfillTimer = null;
    this.queue.length = 0;
  }

  /** One timer, always tracking the player who has waited longest. */
  private armBackfill(): void {
    if (this.backfillTimer !== null || this.queue.length === 0) return;
    const head = this.queue[0];
    if (head === undefined) return;
    const remaining = Math.max(
      0,
      this.options.backfillMs - (this.options.clock.now() - head.since),
    );
    this.backfillTimer = this.options.clock.setTimeout(() => {
      this.backfillTimer = null;
      if (this.queue.length === 0) return;
      this.startFrom(this.queue.splice(0, this.options.matchSize));
      this.armBackfill();
    }, remaining);
  }

  private startFrom(entries: readonly Waiting[]): void {
    const seats: SeatSpec[] = entries.map((entry) => ({ playerId: entry.playerId, kind: 'human' }));
    // R-01 allows 2 to 6; the backfill brings a short queue up to the configured size.
    for (let i = seats.length; i < this.options.matchSize; i += 1) {
      seats.push({ playerId: `bot_${randomUUID().slice(0, 8)}`, kind: 'bot' });
    }
    const matchId = this.newMatchId();
    this.options.log.info('queue.matched', {
      matchId,
      humans: entries.length,
      bots: seats.length - entries.length,
    });
    this.options.onMatch(matchId, seats);
  }
}
