/**
 * Every message that crosses the socket.
 *
 * Inbound messages are parsed with `parseClientMessage` before anything else looks at
 * them: clients are hostile by assumption, so an unvalidated field never reaches the room
 * or the engine. Outbound messages are built from `redactFor` output and nothing else.
 */
import { z } from 'zod';
import { BidSchema, EngineErrorReasonSchema, PlayerViewSchema } from './game.ts';
import { ControlReasonSchema, ProtocolEventSchema } from './events.ts';

const playerId = z.string().min(1).max(64);
const matchId = z.string().min(1).max(64);
const seq = z.number().int().nonnegative();

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

export const SeatStatusSchema = z.strictObject({
  playerId,
  seat: z.number().int().nonnegative(),
  connected: z.boolean(),
  /** Who is acting for this seat right now. */
  control: z.enum(['human', 'bot']),
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
    kind: z.enum(['update', 'sync']),
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

export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCodeSchema>;
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type SeatStatus = z.infer<typeof SeatStatusSchema>;
export type MatchSnapshot = z.infer<typeof MatchSnapshotSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
