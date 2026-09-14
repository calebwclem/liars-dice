/**
 * Which protocol types get generated, and under what Swift name.
 *
 * An explicit list rather than "everything the protocol exports", for two reasons: the output
 * order stays stable so a regeneration produces a clean diff, and the client only needs the
 * shapes it actually handles. `GameEventSchema` and `ServerEventSchema` are deliberately
 * absent — a client only ever sees them merged as `ProtocolEvent`, and generating all three
 * would emit the same payload structs three times.
 */
import { z } from 'zod';
import {
  BidOptionSchema,
  BidOptionsSchema,
  BidRecordSchema,
  BidSchema,
  ClientMessageSchema,
  ControlReasonSchema,
  ErrorCodeSchema,
  FaceSchema,
  MatchConfigSchema,
  MatchSnapshotSchema,
  PhaseSchema,
  PlayerViewSchema,
  ProtocolEventSchema,
  PublicPlayerSchema,
  RevealSummarySchema,
  SeatControlSchema,
  SeatStatusSchema,
  ServerMessageSchema,
  StateKindSchema,
} from '@liars-dice/protocol';
import { declarationFrom, type Decl } from './ir.ts';

/**
 * `io` picks which side of the schema to render. It only matters where a field is optional or
 * has a default: for `ClientMessage`, which this client *writes*, the input shape is the
 * honest one (`hello.token` may be left out). Everything else the client only reads.
 */
interface Entry {
  readonly id: string;
  readonly schema: z.ZodType;
  readonly io: 'input' | 'output';
}

const ENTRIES: readonly Entry[] = [
  { id: 'Face', schema: FaceSchema, io: 'output' },
  { id: 'Bid', schema: BidSchema, io: 'output' },
  { id: 'BidRecord', schema: BidRecordSchema, io: 'output' },
  { id: 'MatchConfig', schema: MatchConfigSchema, io: 'output' },
  { id: 'PublicPlayer', schema: PublicPlayerSchema, io: 'output' },
  { id: 'Phase', schema: PhaseSchema, io: 'output' },
  { id: 'RevealSummary', schema: RevealSummarySchema, io: 'output' },
  { id: 'PlayerView', schema: PlayerViewSchema, io: 'output' },
  { id: 'BidOption', schema: BidOptionSchema, io: 'output' },
  { id: 'BidOptions', schema: BidOptionsSchema, io: 'output' },
  { id: 'ControlReason', schema: ControlReasonSchema, io: 'output' },
  { id: 'SeatControl', schema: SeatControlSchema, io: 'output' },
  { id: 'SeatStatus', schema: SeatStatusSchema, io: 'output' },
  { id: 'StateKind', schema: StateKindSchema, io: 'output' },
  { id: 'MatchSnapshot', schema: MatchSnapshotSchema, io: 'output' },
  { id: 'ProtocolEvent', schema: ProtocolEventSchema, io: 'output' },
  { id: 'ErrorCode', schema: ErrorCodeSchema, io: 'output' },
  { id: 'ServerMessage', schema: ServerMessageSchema, io: 'output' },
  { id: 'ClientMessage', schema: ClientMessageSchema, io: 'input' },
];

/**
 * Convert the whole set in one pass per `io` mode.
 *
 * Registering the schemas together is what makes reuse work: zod emits a `$ref` wherever one
 * registered schema appears inside another, so `MatchSnapshot` points at `PlayerView` instead
 * of inlining a copy of it.
 */
export function declarations(): readonly Decl[] {
  const byId = new Map<string, unknown>();

  for (const io of ['output', 'input'] as const) {
    const entries = ENTRIES.filter((entry) => entry.io === io);
    if (entries.length === 0) continue;
    const registry = z.registry<{ id: string }>();
    // Every entry is registered, not just the ones being emitted in this pass, so that a
    // cross-reference still renders as a `$ref` rather than an inlined copy.
    for (const entry of ENTRIES) registry.add(entry.schema, { id: entry.id });
    const converted = z.toJSONSchema(registry, { io });
    for (const entry of entries) {
      const schema = converted.schemas[entry.id];
      if (schema === undefined) throw new Error(`zod did not emit a schema for ${entry.id}`);
      byId.set(entry.id, schema);
    }
  }

  return ENTRIES.map((entry) => {
    const schema = byId.get(entry.id);
    if (schema === undefined) throw new Error(`missing JSON Schema for ${entry.id}`);
    return declarationFrom(entry.id, schema);
  });
}

export const generatedTypeNames = (): readonly string[] => ENTRIES.map((entry) => entry.id);
