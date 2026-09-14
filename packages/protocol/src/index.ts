/**
 * The contract between every client and the server.
 *
 * `packages/engine` owns the rules; this package owns the wire. The server validates every
 * inbound message against these schemas before the engine sees a field, and builds every
 * outbound message from `redactFor` output. `tools/codegen` (Phase 3) reads these schemas
 * to generate the Swift and Kotlin models, which is why they are the source of truth for
 * shape and nothing hand-written ever is.
 */
export { MIN_PROTOCOL_VERSION, PROTOCOL_VERSION } from './version.ts';
export type { DeepReadonly } from './readonly.ts';

export {
  BidRecordSchema,
  BidSchema,
  EngineErrorReasonSchema,
  FaceSchema,
  GameEventSchema,
  MatchConfigSchema,
  PhaseSchema,
  PlayerViewSchema,
  PublicPlayerSchema,
  RevealSummarySchema,
} from './game.ts';
export type {
  Bid,
  BidRecord,
  EngineErrorReason,
  Face,
  GameEvent,
  MatchConfig,
  Phase,
  PlayerView,
  PublicPlayer,
  RevealSummary,
} from './game.ts';

export { ControlReasonSchema, ProtocolEventSchema, ServerEventSchema } from './events.ts';
export type { ControlReason, ProtocolEvent, ServerEvent } from './events.ts';

export {
  BidOptionSchema,
  BidOptionsSchema,
  ClientMessageSchema,
  ErrorCodeSchema,
  MatchSnapshotSchema,
  ProtocolErrorCodeSchema,
  SeatControlSchema,
  SeatStatusSchema,
  ServerMessageSchema,
  StateKindSchema,
} from './messages.ts';
export type {
  BidOption,
  BidOptions,
  ClientMessage,
  ErrorCode,
  MatchSnapshot,
  ProtocolErrorCode,
  SeatControl,
  SeatStatus,
  ServerMessage,
  StateKind,
} from './messages.ts';

export { encodeServerMessage, MAX_MESSAGE_BYTES, parseClientMessage } from './codec.ts';
export type { ParseFailure, ParseResult } from './codec.ts';
