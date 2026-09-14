/**
 * Events the *server* produces, as opposed to the engine.
 *
 * R-16 to R-19 are about the clock and the sockets, which the engine deliberately knows
 * nothing about (see docs/DECISIONS.md). Their observable consequences still have to reach
 * clients, so they are events here rather than in `packages/engine`.
 *
 * Like engine events, every one of these is safe to broadcast to every player: none
 * carries a die face.
 */
import { z } from 'zod';
import { BidSchema, GameEventSchema } from './game.ts';

const playerId = z.string().min(1).max(64);

/** Why a bot is acting for a seat. */
export const ControlReasonSchema = z.enum([
  /** R-17: two consecutive timeouts. Permanent for the rest of the match. */
  'afk',
  /** R-18: the reconnect grace period lapsed. Cleared if the player comes back. */
  'disconnected',
  /** The seat was filled by a bot at matchmaking; there is no human behind it. */
  'filled',
]);

export const ServerEventSchema = z.discriminatedUnion('type', [
  /** R-16: whose turn it is and how long they have. Sent with every turn change. */
  z.strictObject({
    type: z.literal('turnStarted'),
    playerId,
    turnMs: z.number().int().positive(),
  }),
  /** R-17: the turn ran out. `autoBid` is the raise the server played for them. */
  z.strictObject({
    type: z.literal('playerTimedOut'),
    playerId,
    consecutive: z.number().int().positive(),
    autoBid: BidSchema.nullable(),
  }),
  /** R-18: disconnected, with the grace remaining before a bot steps in. */
  z.strictObject({
    type: z.literal('playerDisconnected'),
    playerId,
    graceMs: z.number().int().nonnegative(),
  }),
  z.strictObject({ type: z.literal('playerReconnected'), playerId }),
  /** R-17 / R-18. */
  z.strictObject({
    type: z.literal('botTookOver'),
    playerId,
    reason: ControlReasonSchema,
  }),
  /** R-18: control handed back after a reconnect inside the grace period. */
  z.strictObject({ type: z.literal('controlReturned'), playerId }),
  /** R-19: every human is gone; the match is over and recorded as abandoned. */
  z.strictObject({ type: z.literal('matchAbandoned'), reason: z.literal('allHumansDisconnected') }),
]);

/**
 * What a client actually receives: engine events and server events in one ordered stream,
 * flat because both are discriminated on `type` and a client wants to replay them in
 * order without caring which side of the boundary produced them.
 */
export const ProtocolEventSchema = z.union([GameEventSchema, ServerEventSchema]);

export type ControlReason = z.infer<typeof ControlReasonSchema>;
export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type ProtocolEvent = z.infer<typeof ProtocolEventSchema>;
