/**
 * Parsing and framing. Nothing else in the system is allowed to `JSON.parse` a socket
 * frame: every inbound byte arrives here first.
 */
import { ClientMessageSchema, type ClientMessage, type ServerMessage } from './messages.ts';

/** PLAN.md wants a size cap on the socket from day one. A legal message is tiny. */
export const MAX_MESSAGE_BYTES = 4_096;

export type ParseFailure =
  | { readonly ok: false; readonly code: 'MESSAGE_TOO_LARGE' }
  | { readonly ok: false; readonly code: 'BAD_MESSAGE'; readonly detail: string };

export type ParseResult = { readonly ok: true; readonly message: ClientMessage } | ParseFailure;

/**
 * Validate one inbound frame. Returns a value rather than throwing, because a malformed
 * frame is an expected event on a public socket, not a bug.
 */
export function parseClientMessage(raw: string | Uint8Array): ParseResult {
  const bytes = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.byteLength;
  if (bytes > MAX_MESSAGE_BYTES) return { ok: false, code: 'MESSAGE_TOO_LARGE' };

  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, code: 'BAD_MESSAGE', detail: 'not JSON' };
  }

  const parsed = ClientMessageSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first === undefined ? '' : `${first.path.join('.')}: ${first.message}`;
    return { ok: false, code: 'BAD_MESSAGE', detail: where };
  }
  return { ok: true, message: parsed.data };
}

export const encodeServerMessage = (message: ServerMessage): string => JSON.stringify(message);
