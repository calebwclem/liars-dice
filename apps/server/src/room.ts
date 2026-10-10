/**
 * A room actor: one match, one in-memory owner, single-threaded by virtue of Node's event
 * loop. PLAN.md picked this shape because it matches the engine's reducer exactly — every
 * change to the match is one `reduce` call from one place.
 *
 * The division of labour is the important thing here. The engine owns the rules (R-01 to
 * R-15) and has no idea what a socket or a clock is. This file owns the clock and the
 * sockets, which is to say it owns R-16 to R-19: the turn timer, the timeout auto-bid, AFK
 * takeover, the reconnect grace period, and abandonment. It never decides whether a bid is
 * legal or who won a challenge.
 *
 * It is also the only place outbound messages are built, and it builds every one of them
 * from `redactFor`. That is deliberate: the redaction guarantee is a property of one
 * function in one file, not a habit spread across a codebase.
 */
import type {
  Action,
  Bid,
  ErrorReason,
  GameEvent,
  GameState,
  PlayerId,
  Transition,
} from '@liars-dice/engine';
import { bidOptionsOf, createMatch, redactFor, reduce, totalDiceInPlay } from '@liars-dice/engine';
import type {
  ControlReason,
  MatchSnapshot,
  ProtocolEvent,
  SeatStatus,
  ServerEvent,
  ServerMessage,
} from '@liars-dice/protocol';
import type { MatchArchive } from './archive.ts';
import type { Clock, TimerHandle } from './clock.ts';
import type { Logger } from './logger.ts';
import { botAction, timeoutAction } from './autoplay.ts';

/** How many transitions of event history to keep for `resume` to replay. */
const HISTORY_LIMIT = 256;

/** R-17: this many consecutive timeouts and a bot takes the seat for good. */
const AFK_TIMEOUT_LIMIT = 2;

export interface SeatSpec {
  readonly playerId: PlayerId;
  /** `bot` means the seat was backfilled at matchmaking; there is no human behind it. */
  readonly kind: 'human' | 'bot';
}

export interface RoomTimings {
  /** R-16 */
  readonly turnMs: number;
  /** R-18 */
  readonly reconnectGraceMs: number;
  /** Presentation pacing, not a rule: how long clients get to show a reveal. */
  readonly revealMs: number;
  readonly botThinkMs: number;
}

export interface RoomOptions {
  readonly matchId: string;
  readonly seats: readonly SeatSpec[];
  readonly timings: RoomTimings;
  readonly clock: Clock;
  /** R-20: a CSPRNG in production. */
  readonly rng: () => number;
  readonly log: Logger;
  /** Deliver to a player's current socket, or drop it if they have none. */
  readonly send: (playerId: PlayerId, message: ServerMessage) => void;
  readonly onFinished?: (room: Room) => void;
  /** Where a finished match is written down, for replay. Omitted means it is not. */
  readonly archive?: MatchArchive;
}

export type RoomStatus = 'active' | 'ended' | 'abandoned';

interface Seat {
  readonly playerId: PlayerId;
  readonly seat: number;
  readonly kind: 'human' | 'bot';
  connected: boolean;
  /** R-17: reset the moment the player acts of their own accord. */
  consecutiveTimeouts: number;
  /** null means the human is in control. */
  botReason: ControlReason | null;
  graceTimer: TimerHandle | null;
}

export type SubmitFailure = ErrorReason | 'NOT_IN_MATCH' | 'SEAT_NOT_YOURS' | 'MATCH_ENDED';

export class Room {
  readonly matchId: string;
  private readonly options: RoomOptions;
  private readonly log: Logger;
  private readonly seats: Map<PlayerId, Seat>;
  private state: GameState;
  private status: RoomStatus = 'active';
  private seq = 0;
  private readonly history: { seq: number; events: readonly ProtocolEvent[] }[] = [];
  /**
   * PLAN.md: persist the action list per match, for deterministic replay. Handed to
   * `options.archive` when the match finishes; see archive.ts for what is safe to write.
   */
  private readonly actionLog: Action[] = [];
  /**
   * Every transition broadcast, for the archive. Separate from `history` on purpose: that one
   * is capped at `HISTORY_LIMIT` because it exists to answer a `resume`, and dropping the
   * early rounds of a match is fine for catching a client up and useless for replaying it.
   * Unbounded only within one match, which is a few hundred entries and then written out.
   */
  private readonly transitions: { seq: number; events: readonly ProtocolEvent[] }[] = [];
  private readonly startedAt: number;
  private turnTimer: TimerHandle | null = null;
  private revealTimer: TimerHandle | null = null;
  private botTimer: TimerHandle | null = null;
  private turnEndsAt: number | null = null;
  /**
   * What the live timer is waiting on. Without this, any event that calls
   * `scheduleForPhase` — someone else reconnecting, say — would clear and re-arm the turn
   * timer, quietly handing the player on turn a fresh 30 seconds (R-16).
   */
  private armed: { kind: 'turn' | 'bot' | 'reveal'; playerId: PlayerId | null } | null = null;

  private constructor(options: RoomOptions, state: GameState) {
    this.options = options;
    this.matchId = options.matchId;
    this.log = options.log.child({ matchId: options.matchId });
    this.state = state;
    this.startedAt = options.clock.now();
    this.seats = new Map(
      options.seats.map((spec, index) => [
        spec.playerId,
        {
          playerId: spec.playerId,
          seat: index,
          kind: spec.kind,
          connected: spec.kind === 'human',
          consecutiveTimeouts: 0,
          // A backfilled seat is bot-driven from the first turn (PLAN.md matchmaking).
          botReason: spec.kind === 'bot' ? ('filled' as const) : null,
          graceTimer: null,
        },
      ]),
    );
  }

  /**
   * Deal the match and tell everyone. Returns an error rather than throwing if the seating
   * is illegal (R-01), since the matchmaker is the one that got it wrong.
   */
  static open(options: RoomOptions): Room | ErrorReason {
    const opened = createMatch(
      { matchId: options.matchId, playerIds: options.seats.map((s) => s.playerId) },
      { now: options.clock.now(), rng: options.rng },
    );
    if (!opened.ok) return opened.reason;

    const room = new Room(options, opened.value.state);
    room.log.info('match.opened', {
      seats: options.seats.map((s) => ({ playerId: s.playerId, kind: s.kind })),
    });
    for (const seat of room.seats.values()) {
      options.send(seat.playerId, {
        type: 'matchFound',
        matchId: options.matchId,
        seats: room.seatStatuses(),
      });
    }
    room.scheduleForPhase();
    room.publish('update', opened.value.events);
    return room;
  }

  get currentStatus(): RoomStatus {
    return this.status;
  }

  get playerIds(): readonly PlayerId[] {
    return [...this.seats.keys()];
  }

  has(playerId: PlayerId): boolean {
    return this.seats.has(playerId);
  }

  /** For tests and for the gateway's logs. Never sent to a client. */
  get debugState(): GameState {
    return this.state;
  }

  get actions(): readonly Action[] {
    return this.actionLog;
  }

  // ─── player intents ─────────────────────────────────────────────────────────

  /**
   * A bid or a challenge from a client. The action is *constructed* here from the
   * authenticated player id, so a client cannot act for somebody else however it frames
   * the message.
   */
  submit(
    playerId: PlayerId,
    intent: { type: 'bid'; bid: Bid } | { type: 'dudo' },
  ): SubmitFailure | null {
    const seat = this.seats.get(playerId);
    if (seat === undefined) return 'NOT_IN_MATCH';
    if (this.status !== 'active') return 'MATCH_ENDED';
    // R-17/R-18: once a bot holds the seat, input from the socket is no longer authoritative
    // for it. Without this, an AFK player could reach back in mid-bot-turn.
    if (seat.botReason !== null) return 'SEAT_NOT_YOURS';

    const action: Action =
      intent.type === 'bid'
        ? { type: 'bid', playerId, bid: intent.bid }
        : { type: 'dudo', playerId };

    const failure = this.apply(action, []);
    if (failure !== null) return failure;
    // A voluntary move clears the AFK streak: R-17 counts *consecutive* timeouts.
    seat.consecutiveTimeouts = 0;
    return null;
  }

  /**
   * R-18: "the client requests a full resync and resumes control". Always answerable — the
   * snapshot is authoritative, and the event replay is a bonus when the history still
   * reaches back that far.
   */
  resume(playerId: PlayerId, afterSeq: number): boolean {
    if (!this.seats.has(playerId)) return false;
    const missed = this.history
      .filter((entry) => entry.seq > afterSeq)
      .flatMap((entry) => entry.events);
    this.options.send(playerId, {
      type: 'state',
      kind: 'sync',
      matchId: this.matchId,
      seq: this.seq,
      events: missed,
      snapshot: this.snapshotFor(playerId),
    });
    this.log.debug('match.resumed', { playerId, afterSeq, replayed: missed.length });
    return true;
  }

  // ─── connection state (R-18, R-19) ──────────────────────────────────────────

  onConnected(playerId: PlayerId): void {
    const seat = this.seats.get(playerId);
    if (seat === undefined || seat.connected) return;
    seat.connected = true;
    this.options.clock.clearTimeout(seat.graceTimer);
    seat.graceTimer = null;

    const events: ServerEvent[] = [{ type: 'playerReconnected', playerId }];
    // R-18: a player whose seat a bot took over *because they dropped* resumes control.
    // R-17's AFK takeover is "for the rest of the match", so that one does not come back.
    if (seat.botReason === 'disconnected') {
      seat.botReason = null;
      seat.consecutiveTimeouts = 0;
      events.push({ type: 'controlReturned', playerId });
    }
    this.log.info('player.reconnected', { playerId, control: seat.botReason ?? 'human' });
    this.publish('update', events);
    // Control may have changed hands, so who the room is waiting on may have changed too.
    this.scheduleForPhase();
  }

  onDisconnected(playerId: PlayerId): void {
    const seat = this.seats.get(playerId);
    if (!seat?.connected) return;
    seat.connected = false;
    this.log.info('player.disconnected', { playerId });

    if (this.status === 'active') {
      this.publish('update', [
        { type: 'playerDisconnected', playerId, graceMs: this.options.timings.reconnectGraceMs },
      ]);
    }

    // R-19: with nobody human watching, the match is over. Checked before the grace timer,
    // because there is no point holding a seat open in an empty room.
    if (this.abandonIfDeserted()) return;

    // R-18: 45 seconds to come back before a bot takes the seat.
    if (seat.botReason === null && this.status === 'active') {
      seat.graceTimer = this.options.clock.setTimeout(() => {
        seat.graceTimer = null;
        if (seat.connected || this.status !== 'active') return;
        this.takeOverSeat(seat, 'disconnected');
      }, this.options.timings.reconnectGraceMs);
    }
  }

  /**
   * A deliberate exit. Unlike a dropped socket this gets no grace period — they said they
   * were going — so a bot takes the seat at once and the match carries on for whoever is
   * left.
   */
  onLeft(playerId: PlayerId): void {
    const seat = this.seats.get(playerId);
    if (seat === undefined) return;
    seat.connected = false;
    this.options.clock.clearTimeout(seat.graceTimer);
    seat.graceTimer = null;
    this.log.info('player.left', { playerId });
    if (this.status !== 'active') return;
    if (this.abandonIfDeserted()) return;
    if (seat.botReason === null) this.takeOverSeat(seat, 'disconnected');
  }

  /**
   * The match is over: write it down, then tell the gateway.
   *
   * Called after the final transition has been published, so the transcript contains it — a
   * match whose archive stopped one event short of the win would be a strange thing to debug
   * with. Archiving before `onFinished` also means it happens before the gateway forgets the
   * room exists.
   */
  private finish(): void {
    const { phase } = this.state;
    this.options.archive?.record({
      matchId: this.matchId,
      status: this.status === 'abandoned' ? 'abandoned' : 'ended',
      startedAt: this.startedAt,
      endedAt: this.options.clock.now(),
      winnerId: phase.kind === 'ended' ? phase.winnerId : null,
      seats: [...this.seats.values()].map((seat) => ({
        playerId: seat.playerId,
        kind: seat.kind,
      })),
      config: this.state.config,
      actions: [...this.actionLog],
      transitions: this.transitions.map((entry) => ({ seq: entry.seq, events: entry.events })),
    });
    this.options.onFinished?.(this);
  }

  /** Stop every timer. Called when the match finishes and when the server shuts down. */
  dispose(): void {
    const { clock } = this.options;
    clock.clearTimeout(this.turnTimer);
    clock.clearTimeout(this.revealTimer);
    clock.clearTimeout(this.botTimer);
    this.turnTimer = null;
    this.revealTimer = null;
    this.botTimer = null;
    this.turnEndsAt = null;
    this.armed = null;
    for (const seat of this.seats.values()) {
      clock.clearTimeout(seat.graceTimer);
      seat.graceTimer = null;
    }
  }

  // ─── the one path that changes the match ────────────────────────────────────

  /**
   * Every state change in the room goes through here: one `reduce`, one broadcast, one
   * re-scheduling of timers. `prefix` carries server events that belong to the same beat as
   * the transition — the timeout that caused the auto-bid, for instance.
   */
  private apply(action: Action, prefix: readonly ServerEvent[]): SubmitFailure | null {
    const result = reduce(this.state, action, {
      now: this.options.clock.now(),
      rng: this.options.rng,
    });
    if (!result.ok) {
      this.log.debug('action.rejected', { action: action.type, reason: result.reason });
      return result.reason;
    }

    this.state = result.value.state;
    this.actionLog.push(action);

    // Settle the room's own state *before* broadcasting: the snapshot reports the turn
    // deadline and the seat statuses, so it has to be built after the timers are arranged.
    const ended = this.settle(result.value);
    this.publish('update', [...prefix, ...result.value.events]);
    if (ended) this.finish();
    return null;
  }

  /** Apply the consequences of a transition to the room. Returns true if the match is over. */
  private settle(transition: Transition): boolean {
    const ended = transition.events.some((event: GameEvent) => event.type === 'matchEnded');
    if (!ended) {
      this.scheduleForPhase();
      return false;
    }
    this.status = 'ended';
    const { phase } = this.state;
    this.log.info('match.ended', {
      winnerId: phase.kind === 'ended' ? phase.winnerId : null,
      rounds: this.state.round.index + 1,
      actions: this.actionLog.length,
    });
    this.dispose();
    return true;
  }

  /**
   * Arm whichever timer the current phase calls for, and only that one.
   *
   * R-16's turn timer runs for a human-controlled seat. A bot-controlled seat gets a think
   * delay instead — it cannot time out, and a zero delay would make clients jump.
   */
  private scheduleForPhase(): void {
    const { clock, timings } = this.options;
    const wanted = this.timerTarget();
    // Already waiting on exactly this? Leave the running timer alone.
    if (
      this.armed !== null &&
      wanted !== null &&
      this.armed.kind === wanted.kind &&
      this.armed.playerId === wanted.playerId
    ) {
      return;
    }

    clock.clearTimeout(this.turnTimer);
    clock.clearTimeout(this.revealTimer);
    clock.clearTimeout(this.botTimer);
    this.turnTimer = null;
    this.revealTimer = null;
    this.botTimer = null;
    this.turnEndsAt = null;
    this.armed = wanted;
    if (wanted === null) return;

    const { phase } = this.state;
    if (phase.kind === 'reveal') {
      this.revealTimer = clock.setTimeout(() => {
        this.revealTimer = null;
        this.armed = null;
        // R-03/R-13/R-14/R-15: the engine decides who starts and re-rolls. The server only
        // decides *when*, which is not a rule — see docs/DECISIONS.md.
        this.apply({ type: 'advanceRound' }, []);
      }, timings.revealMs);
      return;
    }
    if (phase.kind !== 'bidding') return;

    const seat = this.seats.get(phase.turnId);
    if (seat === undefined) return;

    if (seat.botReason !== null) {
      this.botTimer = clock.setTimeout(() => {
        this.botTimer = null;
        this.armed = null;
        if (this.status !== 'active') return;
        this.apply(botAction(this.state, seat.playerId, this.options.rng), []);
      }, timings.botThinkMs);
      return;
    }

    // R-16: 30 seconds, enforced here and nowhere else.
    this.turnEndsAt = clock.now() + timings.turnMs;
    this.turnTimer = clock.setTimeout(() => {
      this.turnTimer = null;
      this.armed = null;
      this.onTurnTimeout(seat);
    }, timings.turnMs);
  }

  /** Who or what the room should currently be waiting on, or null if nothing. */
  private timerTarget(): { kind: 'turn' | 'bot' | 'reveal'; playerId: PlayerId | null } | null {
    if (this.status !== 'active') return null;
    const { phase } = this.state;
    if (phase.kind === 'reveal') return { kind: 'reveal', playerId: null };
    if (phase.kind !== 'bidding') return null;
    const seat = this.seats.get(phase.turnId);
    if (seat === undefined) return null;
    return { kind: seat.botReason === null ? 'turn' : 'bot', playerId: seat.playerId };
  }

  /**
   * R-17. The first timeout plays the minimum legal raise for them. A second one in a row
   * means they are not there: flag AFK and hand the seat to a bot for the rest of the match.
   */
  private onTurnTimeout(seat: Seat): void {
    if (this.status !== 'active') return;
    const { phase } = this.state;
    if (phase.kind !== 'bidding' || phase.turnId !== seat.playerId) return;

    seat.consecutiveTimeouts += 1;
    const consecutive = seat.consecutiveTimeouts;

    if (consecutive >= AFK_TIMEOUT_LIMIT) {
      this.log.info('player.afk', { playerId: seat.playerId, consecutive });
      this.publish('update', [
        { type: 'playerTimedOut', playerId: seat.playerId, consecutive, autoBid: null },
      ]);
      this.takeOverSeat(seat, 'afk');
      return;
    }

    const action = timeoutAction(this.state, seat.playerId);
    this.log.info('player.timedOut', { playerId: seat.playerId, consecutive, played: action.type });
    this.apply(action, [
      {
        type: 'playerTimedOut',
        playerId: seat.playerId,
        consecutive,
        autoBid: action.type === 'bid' ? action.bid : null,
      },
    ]);
  }

  /** R-17 / R-18: a bot has the seat now. */
  private takeOverSeat(seat: Seat, reason: ControlReason): void {
    if (seat.botReason !== null) return;
    seat.botReason = reason;
    this.options.clock.clearTimeout(seat.graceTimer);
    seat.graceTimer = null;
    this.log.info('seat.botTookOver', { playerId: seat.playerId, reason });
    this.publish('update', [{ type: 'botTookOver', playerId: seat.playerId, reason }]);
    // The bot may now be the one on turn.
    this.scheduleForPhase();
  }

  /** R-19: no connected humans left. */
  private abandonIfDeserted(): boolean {
    if (this.status !== 'active') return false;
    const humans = [...this.seats.values()].filter((seat) => seat.kind === 'human');
    if (humans.length === 0 || humans.some((seat) => seat.connected)) return false;

    this.status = 'abandoned';
    this.log.warn('match.abandoned', { reason: 'allHumansDisconnected' });
    this.dispose();
    this.publish('update', [{ type: 'matchAbandoned', reason: 'allHumansDisconnected' }]);
    this.finish();
    return true;
  }

  // ─── the only place a message is built ──────────────────────────────────────

  /**
   * Broadcast one transition. Each player gets their own redacted snapshot; the event list
   * is identical for everyone, which is safe because no event carries a die face outside
   * `diceRevealed` and that one only fires after R-10.
   */
  private publish(kind: 'update' | 'sync', events: readonly ProtocolEvent[]): void {
    this.seq += 1;
    this.history.push({ seq: this.seq, events });
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.transitions.push({ seq: this.seq, events });

    for (const seat of this.seats.values()) {
      this.options.send(seat.playerId, {
        type: 'state',
        kind,
        matchId: this.matchId,
        seq: this.seq,
        events,
        snapshot: this.snapshotFor(seat.playerId),
      });
    }
  }

  /**
   * `redactFor` plus the two things the engine does not know: how long the current turn has
   * left (R-16) and who is actually connected (R-18). The deadline is relative so a client
   * with a skewed clock still draws the right ring.
   */
  private snapshotFor(playerId: PlayerId): MatchSnapshot {
    const remaining =
      this.turnEndsAt === null ? null : Math.max(0, this.turnEndsAt - this.options.clock.now());
    // Only the player on turn is told what they may bid: it is the answer to a question
    // nobody else is being asked, and R-04's cap makes it recipient-independent anyway.
    const onTurn = this.state.phase.kind === 'bidding' && this.state.phase.turnId === playerId;
    return {
      view: redactFor(this.state, playerId),
      turnEndsInMs: remaining === null ? null : Math.round(remaining),
      turnMs: this.options.timings.turnMs,
      seats: this.seatStatuses(),
      bidOptions: onTurn
        ? { options: bidOptionsOf(this.state), maxQuantity: totalDiceInPlay(this.state) }
        : null,
    };
  }

  private seatStatuses(): readonly SeatStatus[] {
    return [...this.seats.values()]
      .sort((a, b) => a.seat - b.seat)
      .map((seat) => ({
        playerId: seat.playerId,
        seat: seat.seat,
        connected: seat.connected,
        control: seat.botReason === null ? ('human' as const) : ('bot' as const),
        controlReason: seat.botReason,
      }));
  }
}
