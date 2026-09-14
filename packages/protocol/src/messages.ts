/**
 * Every message that crosses the socket.
 *
 * Inbound messages are parsed with `parseClientMessage` before anything else looks at
 * them: clients are hostile by assumption, so an unvalidated field never reaches the room
 * or the engine. Outbound messages are built from `redactFor` output and nothing else.
 */
import { z } from 'zod';
import type { DeepReadonly } from './readonly.ts';
import { BidSchema, EngineErrorReasonSchema, FaceSchema, PlayerViewSchema } from './game.ts';
import { ControlReasonSchema, ProtocolEventSchema } from './events.ts';

const playerId = z.string().min(1).max(64);
const matchId = z.string().min(1).max(64);
const seq = z.number().int().nonnegative();

/**
 * Why a state message was sent: a live transition, or the answer to a `resume`. A client can use
 * it to skip animations when catching up after a reconnect.
 */
export const StateKindSchema = z.enum(['update', 'sync']);

/** Problems that belong to the transport or the session rather than to the rules. */
export const ProtocolErrorCodeSchema = z.enum([
  'BAD_MESSAGE',
  'MESSAGE_TOO_LARGE',
  'RATE_LIMITED',
  'HELLO_REQUIRED',
  'BAD_TOKEN',
  'UNKNOWN_MATCH',
  'NOT_IN_MATCH',
  'ALREADY_IN_MATCH',
  'ALREADY_QUEUED',
  'NOT_QUEUED',
  'SEQ_TOO_OLD',
  'SEAT_NOT_YOURS',
  'INTERNAL',
]);

/** A rules rejection or a transport rejection; a client can branch on either. */
export const ErrorCodeSchema = z.union([EngineErrorReasonSchema, ProtocolErrorCodeSchema]);

// ─── client -> server ─────────────────────────────────────────────────────────

export const ClientMessageSchema = z.discriminatedUnion('type', [
  /** Always first. `token` resumes an existing guest identity; omit it to be issued one. */
  z.strictObject({
    type: z.literal('hello'),
    protocolVersion: z.number().int().positive(),
    token: z.string().max(512).optional(),
  }),
  z.strictObject({ type: z.literal('findMatch') }),
  z.strictObject({ type: z.literal('cancelQueue') }),
  z.strictObject({ type: z.literal('bid'), matchId, bid: BidSchema }),
  z.strictObject({ type: z.literal('dudo'), matchId }),
  /**
   * R-18: "give me everything after seq N". The server replies with a full snapshot plus
   * whatever events it still holds past N.
   */
  z.strictObject({ type: z.literal('resume'), matchId, afterSeq: seq }),
  z.strictObject({ type: z.literal('leave'), matchId }),
  z.strictObject({ type: z.literal('ping') }),
]);

// ─── server -> client ─────────────────────────────────────────────────────────

/**
 * What the recipient may legally bid, described without any rule a client would have to
 * understand.
 *
 * For a fixed face the legal quantities are one contiguous run from a minimum up to the dice
 * still in play (R-04's cap), so six numbers describe the whole legal set. That lets a client
 * grey out an impossible button while containing zero rules logic — CLAUDE.md allows the
 * former and forbids the latter, and sending the *answers* rather than the rules is how both
 * hold at once. `packages/engine` computes it and a property test pins the contiguity.
 */
export const BidOptionSchema = z.strictObject({
  face: FaceSchema,
  /** Null when that face cannot be bid at all — see R-09's dead end. */
  minQuantity: z.number().int().positive().nullable(),
});

export const BidOptionsSchema = z.strictObject({
  /** One entry per face, faces 1 through 6 in order. */
  options: z.array(BidOptionSchema),
  /** R-04: no bid may exceed this. */
  maxQuantity: z.number().int().nonnegative(),
});

/** Who is acting for a seat right now. */
export const SeatControlSchema = z.enum(['human', 'bot']);

export const SeatStatusSchema = z.strictObject({
  playerId,
  seat: z.number().int().nonnegative(),
  connected: z.boolean(),
  control: SeatControlSchema,
  controlReason: ControlReasonSchema.nullable(),
});

/**
 * A redacted view plus the two things the server owns and the engine does not: the R-16
 * turn deadline and who is actually connected.
 *
 * The deadline is relative, not absolute, so a client with a skewed clock still draws the
 * right timer ring.
 */
export const MatchSnapshotSchema = z.strictObject({
  view: PlayerViewSchema,
  turnEndsInMs: z.number().int().nonnegative().nullable(),
  seats: z.array(SeatStatusSchema),
  /** Present only when it is this recipient's turn to act. */
  bidOptions: BidOptionsSchema.nullable(),
});

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('welcome'),
    protocolVersion: z.number().int().positive(),
    playerId,
    /** Keep this: presenting it on a later connect restores the same guest identity. */
    token: z.string(),
  }),
  z.strictObject({
    type: z.literal('updateRequired'),
    serverProtocolVersion: z.number().int().positive(),
    minProtocolVersion: z.number().int().positive(),
    message: z.string(),
  }),
  z.strictObject({
    type: z.literal('queued'),
    waiting: z.number().int().positive(),
    target: z.number().int().positive(),
    /** How long until the queue backfills with bots and starts anyway. */
    backfillInMs: z.number().int().nonnegative(),
  }),
  z.strictObject({ type: z.literal('queueCancelled') }),
  z.strictObject({
    type: z.literal('matchFound'),
    matchId,
    seats: z.array(SeatStatusSchema),
  }),
  /**
   * The only message that carries game state. `update` is a live transition; `sync` is the
   * answer to `resume`. Both carry the full snapshot, so a client never has to derive
   * state from the event list — the events exist for animation, not for truth.
   */
  z.strictObject({
    type: z.literal('state'),
    kind: StateKindSchema,
    matchId,
    seq,
    events: z.array(ProtocolEventSchema),
    snapshot: MatchSnapshotSchema,
  }),
  z.strictObject({
    type: z.literal('error'),
    code: ErrorCodeSchema,
    detail: z.string().nullable(),
  }),
  z.strictObject({ type: z.literal('pong') }),
]);

export type SeatControl = DeepReadonly<z.infer<typeof SeatControlSchema>>;
export type StateKind = DeepReadonly<z.infer<typeof StateKindSchema>>;
export type BidOption = DeepReadonly<z.infer<typeof BidOptionSchema>>;
export type BidOptions = DeepReadonly<z.infer<typeof BidOptionsSchema>>;
export type ProtocolErrorCode = DeepReadonly<z.infer<typeof ProtocolErrorCodeSchema>>;
export type ErrorCode = DeepReadonly<z.infer<typeof ErrorCodeSchema>>;
export type ClientMessage = DeepReadonly<z.infer<typeof ClientMessageSchema>>;
export type SeatStatus = DeepReadonly<z.infer<typeof SeatStatusSchema>>;
export type MatchSnapshot = DeepReadonly<z.infer<typeof MatchSnapshotSchema>>;
export type ServerMessage = DeepReadonly<z.infer<typeof ServerMessageSchema>>;
