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
export const PROTOCOL_VERSION = 1;

/** The oldest client version this server still accepts. */
export const MIN_PROTOCOL_VERSION = 1;
