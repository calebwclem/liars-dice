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
import type { DeepReadonly } from './readonly.ts';
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
 * What a client actually receives: engine events and server events in one ordered stream.
 *
 * Built as a single discriminated union over both sets of variants rather than a union of
 * two unions. A client wants to switch once over sixteen cases, not twice over two — and it
 * means `tools/codegen` emits one flat Swift enum instead of a nested pair. The variants
 * still come from the two schemas above, so there is nothing to keep in step by hand.
 */
export const ProtocolEventSchema = z.discriminatedUnion('type', [
  ...GameEventSchema.options,
  ...ServerEventSchema.options,
]);

export type ControlReason = DeepReadonly<z.infer<typeof ControlReasonSchema>>;
export type ServerEvent = DeepReadonly<z.infer<typeof ServerEventSchema>>;
export type ProtocolEvent = DeepReadonly<z.infer<typeof ProtocolEventSchema>>;
