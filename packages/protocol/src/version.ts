/**
 * The wire contract version. Every client sends it on connect and the server refuses a
 * version it cannot speak — PLAN.md is emphatic that retrofitting this after launch is
 * painful, so it exists from message #1.
 *
 * Bump it for any change to a message shape. The schemas are strict — an unexpected key is
 * a parse error, not something stripped on the way past — so even an added field is a
 * change an older peer can see. Swift's JSONDecoder ignores unknown keys, so a generated
 * client tolerates additions in practice; the version gate is what makes that a decision
 * rather than an accident.
 */
export const PROTOCOL_VERSION = 4;

/**
 * The oldest client version this server still accepts.
 *
 * Raised to 2 with the palifico removal (R-13). That change *dropped* fields rather than
 * adding them — `round.palifico`, `round.lockedFace`, `player.palificoUsed`,
 * `reveal.wildOnes`, the `palificoArmed` event, the `PALIFICO_FACE_LOCKED` error — and a
 * v1 client decoding a v2 snapshot would find them missing, not merely unfamiliar. There
 * is nothing shipped to be compatible with yet, so the gate simply refuses v1.
 *
 * Version 3 adds private parties. That change is purely additive — four client messages, two
 * server messages, six error codes — and a v2 client never sends or receives any of them, so
 * it would in principle still work. The minimum stays at 2 rather than rising to 3 for
 * exactly that reason: raise the floor when old clients would *break*, not merely when they
 * would miss out. A v2 client simply has no button for private games.
 *
 * Version 4 adds `rematch`, one client message, and nothing else. The floor stays at 2 on the
 * same reasoning, and the *direction* is what makes it safe: the server gained a message it can
 * receive, so an older client that never sends it is unaffected. A new field on a server
 * message would have been a different matter — these schemas are strict, so an extra key is a
 * parse failure rather than something quietly ignored, and an older browser client would have
 * dropped the whole message on the floor. That is why the rematch button is worked out from
 * what the client already saw rather than from anything new on the wire.
 */
export const MIN_PROTOCOL_VERSION = 2;
