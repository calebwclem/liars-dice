/**
 * The complete vocabulary of the engine. Every type here is a plain JSON value:
 * no `Map`, no `Set`, no `Date`, no `undefined`, and no optional properties. That is
 * what makes `JSON.parse(JSON.stringify(state))` round-trip identically, and it is what
 * will let `packages/protocol` describe this shape in Zod without a translation layer.
 *
 * Rule IDs in comments refer to docs/RULES.md, which is the spec. If a comment and that
 * document disagree, the document wins.
 */

/** A die face. R-02: six-sided, 1 through 6. */
export type Face = 1 | 2 | 3 | 4 | 5 | 6;

export const FACES: readonly Face[] = [1, 2, 3, 4, 5, 6];

export type PlayerId = string;

/**
 * R-04. "At least `quantity` dice, across all dice still in play, show `face`."
 * `quantity` is an integer in `1 .. totalDiceInPlay(state)`.
 */
export interface Bid {
  readonly quantity: number;
  readonly face: Face;
}

export interface MatchConfig {
  /** R-02: 5. */
  readonly startingDice: number;
  /** R-11: 5. Asserted as an invariant — no v1 rule hands a die back. */
  readonly maxDice: number;
}

export interface PlayerState {
  readonly id: PlayerId;
  /** Equals this player's index in `GameState.players`. R-05: seat order is fixed. */
  readonly seat: number;
  /** Dice owned, 0..maxDice. 0 means eliminated (R-12). */
  readonly diceCount: number;
  /** R-13: a player may trigger palifico only once per match. */
  readonly palificoUsed: boolean;
}

export interface BidRecord {
  readonly playerId: PlayerId;
  readonly bid: Bid;
}

export interface RoundState {
  /** 0-based. */
  readonly index: number;
  /** R-13. When true: ones are not wild, the face is locked by the opening bid. */
  readonly palifico: boolean;
  /** R-05 / R-13 / R-14 / R-15: who made (or must make) the opening bid. */
  readonly starterId: PlayerId;
  /**
   * R-03: rolled secretly at round start. Full information — this is the field
   * `redactFor` exists to strip. Keyed by player id; eliminated players are absent.
   */
  readonly hands: Readonly<Record<PlayerId, readonly Face[]>>;
  /** Bid history in order. The standing bid is the last element. */
  readonly bids: readonly BidRecord[];
}

/**
 * Where the match is. Modelled as a union so that impossible combinations cannot be
 * represented: there is no turn holder during a reveal, and no turn holder after the
 * match ends.
 */
export type Phase =
  | { readonly kind: 'bidding'; readonly turnId: PlayerId }
  | { readonly kind: 'reveal' }
  | { readonly kind: 'ended'; readonly winnerId: PlayerId };

/**
 * R-10. The outcome of a dudo, and the only place hands become public.
 *
 * `bidStands`, `loserId` and `actualCount` are all recomputable from `hands` and `bid`,
 * but they *are* the output of R-10, so the record states them rather than making every
 * reader re-derive the rule.
 */
export interface RevealSummary {
  readonly roundIndex: number;
  readonly challengerId: PlayerId;
  readonly bidderId: PlayerId;
  readonly bid: Bid;
  /** R-07 / R-13: whether ones counted as wild when tallying. */
  readonly wildOnes: boolean;
  readonly actualCount: number;
  /** R-10: `actualCount >= bid.quantity`. True means the challenger was wrong. */
  readonly bidStands: boolean;
  readonly hands: Readonly<Record<PlayerId, readonly Face[]>>;
  /** The challenger if `bidStands`, otherwise the bidder. */
  readonly loserId: PlayerId;
  /** The loser's dice count *after* losing the die. */
  readonly loserDiceCount: number;
  /** R-12: set when the loser hit 0 dice. */
  readonly eliminatedId: PlayerId | null;
}

/** Full information. Server-side only — never send this to a client; send `redactFor`. */
export interface GameState {
  readonly matchId: string;
  readonly config: MatchConfig;
  /** Index equals seat. R-05: clockwise, fixed for the match. */
  readonly players: readonly PlayerState[];
  /** The current round, or — during a reveal — the round just finished. */
  readonly round: RoundState;
  readonly phase: Phase;
  /** The most recent reveal, or null before the first challenge. Public (R-10). */
  readonly lastReveal: RevealSummary | null;
  /** R-13: armed when a player drops to 1 die; consumed by the next `advanceRound`. */
  readonly palificoNextFor: PlayerId | null;
  /** Monotonic reduce counter. PLAN.md wants a sequence number for resync. */
  readonly seq: number;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

/**
 * What a player is allowed to see. The *only* client-facing shape, produced solely by
 * `redactFor`. Another player's dice must never appear here before a reveal — there is a
 * test asserting exactly that, and CLAUDE.md forbids weakening it.
 */
export interface PublicPlayer {
  readonly id: PlayerId;
  readonly seat: number;
  readonly diceCount: number;
  readonly eliminated: boolean;
  readonly palificoUsed: boolean;
}

export interface PlayerView {
  readonly matchId: string;
  readonly seq: number;
  readonly config: MatchConfig;
  /**
   * The viewer's own seat and hand, or null if they are not in this match. There is
   * deliberately no dice *count* here: the viewer reads their owned count from
   * `players[seat].diceCount`, because during a reveal the two differ — `dice` is the
   * hand that was just counted, while `diceCount` is already the post-loss number they
   * will roll next round.
   */
  readonly you: {
    readonly id: PlayerId;
    readonly seat: number;
    readonly dice: readonly Face[];
  } | null;
  readonly players: readonly PublicPlayer[];
  readonly phase: Phase;
  readonly round: {
    readonly index: number;
    readonly palifico: boolean;
    readonly starterId: PlayerId;
    /** R-13: the face locked by the opening bid of a palifico round; null otherwise. */
    readonly lockedFace: Face | null;
    readonly bids: readonly BidRecord[];
  };
  /** R-10: hands are public here, and nowhere else. */
  readonly lastReveal: RevealSummary | null;
  /** R-04: the ceiling on a legal bid quantity. */
  readonly totalDiceInPlay: number;
}

/**
 * `bid` and `dudo` are player intents and arrive from clients, so they are validated
 * without mercy. `advanceRound` is issued by the server once it has shown the reveal for
 * long enough; it must never be accepted over the socket.
 */
export type Action =
  | { readonly type: 'bid'; readonly playerId: PlayerId; readonly bid: Bid }
  | { readonly type: 'dudo'; readonly playerId: PlayerId }
  | { readonly type: 'advanceRound' };

/**
 * Every event is safe to broadcast verbatim to every player. No event carries a die face
 * except `diceRevealed`, which is emitted only after R-10 has fired. A player learns
 * their own hand from `redactFor`, never from an event.
 */
export type GameEvent =
  | {
      readonly type: 'matchStarted';
      readonly playerIds: readonly PlayerId[];
      readonly startingDice: number;
    }
  | {
      readonly type: 'roundStarted';
      readonly index: number;
      readonly starterId: PlayerId;
      readonly palifico: boolean;
      readonly diceCounts: Readonly<Record<PlayerId, number>>;
    }
  | { readonly type: 'bidMade'; readonly playerId: PlayerId; readonly bid: Bid }
  | {
      readonly type: 'dudoCalled';
      readonly playerId: PlayerId;
      readonly bidderId: PlayerId;
      readonly bid: Bid;
    }
  | { readonly type: 'diceRevealed'; readonly reveal: RevealSummary }
  | { readonly type: 'dieLost'; readonly playerId: PlayerId; readonly diceCount: number }
  | { readonly type: 'playerEliminated'; readonly playerId: PlayerId }
  | { readonly type: 'palificoArmed'; readonly playerId: PlayerId }
  | { readonly type: 'matchEnded'; readonly winnerId: PlayerId };

/**
 * Injected time and randomness. CLAUDE.md rule 3: the engine reads no clock and no
 * entropy of its own. R-20: the server passes a CSPRNG here; tests and the CLI pass a
 * seeded PRNG so a match can be replayed exactly.
 */
export interface Ctx {
  readonly now: number;
  /** Uniform in [0, 1), like `Math.random`. */
  readonly rng: () => number;
}

/** Illegal actions are values, not exceptions (CLAUDE.md, TypeScript conventions). */
export type ErrorReason =
  /** The match is over; nothing further is legal. */
  | 'MATCH_ENDED'
  /** Right action, wrong moment — bidding during a reveal, advancing during bidding. */
  | 'WRONG_PHASE'
  | 'UNKNOWN_PLAYER'
  | 'NOT_YOUR_TURN'
  /** R-12: the player has no dice left. */
  | 'PLAYER_ELIMINATED'
  /** R-04: not a positive integer. */
  | 'BID_QUANTITY_INVALID'
  /** R-04: above the total dice still in play. */
  | 'BID_EXCEEDS_DICE_IN_PLAY'
  /** R-02: not a face in 1..6. */
  | 'BID_FACE_INVALID'
  /** R-08 / R-09: not a legal raise over the standing bid. */
  | 'BID_TOO_LOW'
  /** R-13: a palifico round's face is locked by its opening bid. */
  | 'PALIFICO_FACE_LOCKED'
  /** R-06: the round's first player must bid; they cannot challenge. */
  | 'OPENING_BID_REQUIRED'
  /** R-01: a match needs 2 to 6 players with distinct ids. */
  | 'INVALID_PLAYER_COUNT'
  | 'DUPLICATE_PLAYER_ID';

export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: ErrorReason };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T = never>(reason: ErrorReason): Result<T> => ({ ok: false, reason });

/** What `reduce` returns on success: the next state, plus the public event log. */
export interface Transition {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}
