/**
 * Schemas for the game shapes the engine produces.
 *
 * These mirror `packages/engine`'s types exactly, and `test/drift.test.ts` fails if they
 * drift apart — both at the type level and by parsing real engine output. The duplication
 * is deliberate: the engine must stay dependency-free and the wire format needs runtime
 * validation, so the schemas live here and the equivalence is enforced by a test rather
 * than by hope. `tools/codegen` reads this file to generate the Swift models.
 */
import { z } from 'zod';
import type { DeepReadonly } from './readonly.ts';

const playerId = z.string().min(1).max(64);
const count = z.number().int().nonnegative();

/** R-02: six-sided, faces 1 to 6. */
export const FaceSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
]);

/** R-04: quantity is a positive integer; the engine enforces the dice-in-play ceiling. */
export const BidSchema = z.strictObject({
  quantity: z.number().int().positive(),
  face: FaceSchema,
});

export const BidRecordSchema = z.strictObject({
  playerId,
  bid: BidSchema,
});

export const PhaseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('bidding'), turnId: playerId }),
  z.strictObject({ kind: z.literal('reveal') }),
  z.strictObject({ kind: z.literal('ended'), winnerId: playerId }),
]);

/** R-10: the only shape that carries every player's dice, and only after a reveal. */
export const RevealSummarySchema = z.strictObject({
  roundIndex: count,
  challengerId: playerId,
  bidderId: playerId,
  bid: BidSchema,
  actualCount: count,
  bidStands: z.boolean(),
  hands: z.record(playerId, z.array(FaceSchema)),
  loserId: playerId,
  loserDiceCount: count,
  eliminatedId: playerId.nullable(),
});

export const PublicPlayerSchema = z.strictObject({
  id: playerId,
  seat: count,
  diceCount: count,
  eliminated: z.boolean(),
});

export const MatchConfigSchema = z.strictObject({
  startingDice: z.number().int().positive(),
  maxDice: z.number().int().positive(),
});

/**
 * The redacted snapshot. `redactFor` is the only thing allowed to produce one, and note
 * what is missing: there is no field here that could hold another player's dice outside
 * `lastReveal`.
 */
export const PlayerViewSchema = z.strictObject({
  matchId: z.string().min(1).max(64),
  seq: count,
  config: MatchConfigSchema,
  you: z
    .object({
      id: playerId,
      seat: count,
      dice: z.array(FaceSchema),
    })
    .nullable(),
  players: z.array(PublicPlayerSchema),
  phase: PhaseSchema,
  round: z.strictObject({
    index: count,
    starterId: playerId,
    bids: z.array(BidRecordSchema),
  }),
  lastReveal: RevealSummarySchema.nullable(),
  totalDiceInPlay: count,
});

/** Public events from the engine. Every one is safe to broadcast to every player. */
export const GameEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('matchStarted'),
    playerIds: z.array(playerId),
    startingDice: z.number().int().positive(),
  }),
  z.strictObject({
    type: z.literal('roundStarted'),
    index: count,
    starterId: playerId,
    diceCounts: z.record(playerId, count),
  }),
  z.strictObject({ type: z.literal('bidMade'), playerId, bid: BidSchema }),
  z.strictObject({
    type: z.literal('dudoCalled'),
    playerId,
    bidderId: playerId,
    bid: BidSchema,
  }),
  z.strictObject({ type: z.literal('diceRevealed'), reveal: RevealSummarySchema }),
  z.strictObject({ type: z.literal('dieLost'), playerId, diceCount: count }),
  z.strictObject({ type: z.literal('playerEliminated'), playerId }),
  z.strictObject({ type: z.literal('matchEnded'), winnerId: playerId }),
]);

/** Mirrors the engine's ErrorReason. The drift test asserts the two stay in step. */
export const EngineErrorReasonSchema = z.enum([
  'MATCH_ENDED',
  'WRONG_PHASE',
  'UNKNOWN_PLAYER',
  'NOT_YOUR_TURN',
  'PLAYER_ELIMINATED',
  'BID_QUANTITY_INVALID',
  'BID_EXCEEDS_DICE_IN_PLAY',
  'BID_FACE_INVALID',
  'BID_TOO_LOW',
  'OPENING_BID_REQUIRED',
  'INVALID_PLAYER_COUNT',
  'DUPLICATE_PLAYER_ID',
]);

export type Face = DeepReadonly<z.infer<typeof FaceSchema>>;
export type Bid = DeepReadonly<z.infer<typeof BidSchema>>;
export type BidRecord = DeepReadonly<z.infer<typeof BidRecordSchema>>;
export type Phase = DeepReadonly<z.infer<typeof PhaseSchema>>;
export type RevealSummary = DeepReadonly<z.infer<typeof RevealSummarySchema>>;
export type PublicPlayer = DeepReadonly<z.infer<typeof PublicPlayerSchema>>;
export type MatchConfig = DeepReadonly<z.infer<typeof MatchConfigSchema>>;
export type PlayerView = DeepReadonly<z.infer<typeof PlayerViewSchema>>;
export type GameEvent = DeepReadonly<z.infer<typeof GameEventSchema>>;
export type EngineErrorReason = DeepReadonly<z.infer<typeof EngineErrorReasonSchema>>;
