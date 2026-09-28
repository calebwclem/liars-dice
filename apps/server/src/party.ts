/**
 * Private games: players gathered behind a shared code, waiting for the host to start.
 *
 * "Party" rather than "room" because `Room` is already the live-match actor in this server,
 * and the iOS client already calls its idle screen the lobby. Three names for three things:
 * a **party** is people waiting behind a code, the **queue** is strangers waiting for the
 * matchmaker, and a **room** is a match in progress. A player is in at most one party or
 * queue, and in neither once their room is open. The UI calls a party a "private game".
 *
 * The same shape as the matchmaker, for the same reasons: in memory, single instance, a Map
 * and nothing else. See docs/DECISIONS.md — Redis arrives when there is a second machine.
 *
 * Errors are values here, as in the engine. Every failure a client could cause is returned
 * as an `ErrorCode` for the gateway to send back verbatim; nothing throws.
 */
import { randomUUID } from 'node:crypto';
import type { PlayerId } from '@liars-dice/engine';
import type { ErrorCode } from '@liars-dice/protocol';
import { PARTY_CODE_ALPHABET, PARTY_CODE_LENGTH } from '@liars-dice/protocol';
import type { Logger } from './logger.ts';
import type { SeatSpec } from './room.ts';

/** R-01: a match needs 2 to 6 players, so a party is bounded by the same numbers. */
export const MIN_PARTY_SIZE = 2;
export const MAX_PARTY_SIZE = 6;

/** How many times to re-roll a code before giving up. See `newUniqueCode`. */
const CODE_ATTEMPTS = 20;

/** Exactly the `partyState` message's payload, minus the discriminator. */
export interface PartyView {
  readonly code: string;
  readonly hostId: PlayerId;
  readonly members: readonly PlayerId[];
  readonly minSize: number;
  readonly maxSize: number;
}

export interface PartiesOptions {
  /** The table size a bot fill aims for — the same one the public queue uses. */
  readonly matchSize: number;
  readonly log: Logger;
  /** Called with the seating once the host starts. */
  readonly onStart: (matchId: string, seats: readonly SeatSpec[]) => void;
  /** Called whenever a party changes, so the gateway can broadcast it to its members. */
  readonly onChanged: (party: PartyView) => void;
  readonly newCode?: () => string;
  readonly newMatchId?: () => string;
}

interface Party {
  readonly code: string;
  hostId: PlayerId;
  readonly members: PlayerId[];
}

export class Parties {
  private readonly options: PartiesOptions;
  private readonly byCode = new Map<string, Party>();
  private readonly byPlayer = new Map<PlayerId, string>();
  private readonly newCode: () => string;
  private readonly newMatchId: () => string;

  constructor(options: PartiesOptions) {
    this.options = options;
    this.newCode = options.newCode ?? randomCode;
    this.newMatchId = options.newMatchId ?? (() => `m_${randomUUID()}`);
  }

  get size(): number {
    return this.byCode.size;
  }

  isInParty(playerId: PlayerId): boolean {
    return this.byPlayer.has(playerId);
  }

  partyOf(playerId: PlayerId): PartyView | undefined {
    const code = this.byPlayer.get(playerId);
    if (code === undefined) return undefined;
    const party = this.byCode.get(code);
    return party === undefined ? undefined : viewOf(party);
  }

  /** A new party with this player as its host, or the reason they cannot have one. */
  create(playerId: PlayerId): PartyView | ErrorCode {
    if (this.byPlayer.has(playerId)) return 'ALREADY_IN_PARTY';
    const code = this.newUniqueCode();
    if (code === null) return 'INTERNAL';

    const party: Party = { code, hostId: playerId, members: [playerId] };
    this.byCode.set(code, party);
    this.byPlayer.set(playerId, code);
    this.options.log.info('party.created', { code, hostId: playerId });
    return this.changed(party);
  }

  join(playerId: PlayerId, code: string): PartyView | ErrorCode {
    if (this.byPlayer.has(playerId)) return 'ALREADY_IN_PARTY';
    const party = this.byCode.get(code);
    if (party === undefined) return 'UNKNOWN_PARTY';
    if (party.members.length >= MAX_PARTY_SIZE) return 'PARTY_FULL';

    party.members.push(playerId);
    this.byPlayer.set(playerId, code);
    this.options.log.debug('party.joined', { code, playerId, members: party.members.length });
    return this.changed(party);
  }

  /** True if they were in one. Dissolves the party if that was the last member. */
  leave(playerId: PlayerId): boolean {
    const code = this.byPlayer.get(playerId);
    if (code === undefined) return false;
    this.byPlayer.delete(playerId);

    const party = this.byCode.get(code);
    if (party === undefined) return true;

    const at = party.members.indexOf(playerId);
    if (at !== -1) party.members.splice(at, 1);

    const [next] = party.members;
    if (next === undefined) {
      this.byCode.delete(code);
      this.options.log.info('party.dissolved', { code });
      return true;
    }
    // The host is whoever has been here longest. Dissolving instead would punish everybody
    // for one person's connection dropping, and a disconnect is how most hosts will leave.
    if (party.hostId === playerId) party.hostId = next;
    this.options.log.debug('party.left', { code, playerId, members: party.members.length });
    this.changed(party);
    return true;
  }

  /** Host only. Null on success — the match is opened through `onStart`. */
  start(playerId: PlayerId, fillWithBots: boolean): ErrorCode | null {
    const code = this.byPlayer.get(playerId);
    if (code === undefined) return 'NOT_IN_PARTY';
    const party = this.byCode.get(code);
    if (party === undefined) return 'NOT_IN_PARTY';
    if (party.hostId !== playerId) return 'NOT_PARTY_HOST';
    if (party.members.length < MIN_PARTY_SIZE) return 'PARTY_TOO_SMALL';

    const seats: SeatSpec[] = party.members.map((id) => ({ playerId: id, kind: 'human' }));
    // Only ever tops *up*: a party already at or past the usual table size plays as it is,
    // and R-01's ceiling is enforced by the party being capped at six in the first place.
    if (fillWithBots) {
      for (let i = seats.length; i < this.options.matchSize; i += 1) {
        seats.push({ playerId: `bot_${randomUUID().slice(0, 8)}`, kind: 'bot' });
      }
    }

    // Dissolve before opening the room: `onStart` reaches the gateway synchronously, and it
    // must not find these players still listed as waiting behind a code.
    this.byCode.delete(code);
    for (const id of party.members) this.byPlayer.delete(id);

    const matchId = this.newMatchId();
    this.options.log.info('party.started', {
      code,
      matchId,
      humans: party.members.length,
      bots: seats.length - party.members.length,
    });
    this.options.onStart(matchId, seats);
    return null;
  }

  dispose(): void {
    this.byCode.clear();
    this.byPlayer.clear();
  }

  private changed(party: Party): PartyView {
    const view = viewOf(party);
    this.options.onChanged(view);
    return view;
  }

  /**
   * Codes are random rather than sequential, so one cannot be guessed by adding one to the
   * code a friend just read out. Collisions are unlikely and handled rather than assumed
   * away; exhausting the attempts means the space is genuinely crowded, which is a capacity
   * problem and not something a client can fix.
   */
  private newUniqueCode(): string | null {
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
      const code = this.newCode();
      if (!this.byCode.has(code)) return code;
    }
    this.options.log.error('party.codeExhausted', { parties: this.byCode.size });
    return null;
  }
}

function viewOf(party: Party): PartyView {
  return {
    code: party.code,
    hostId: party.hostId,
    members: [...party.members],
    minSize: MIN_PARTY_SIZE,
    maxSize: MAX_PARTY_SIZE,
  };
}

function randomCode(): string {
  // `randomUUID` is already seeded from the system CSPRNG; a code is not a secret, but it is
  // the only thing stopping a stranger walking into a private game, so it should not come
  // from `Math.random()` either.
  const bytes = randomUUID().replace(/-/g, '');
  let code = '';
  for (let i = 0; i < PARTY_CODE_LENGTH; i += 1) {
    const byte = Number.parseInt(bytes.slice(i * 2, i * 2 + 2), 16);
    // `slice` rather than an index: the modulo makes it always in range, but under
    // `noUncheckedIndexedAccess` an index is `string | undefined` and `slice` is not.
    const at = byte % PARTY_CODE_ALPHABET.length;
    code += PARTY_CODE_ALPHABET.slice(at, at + 1);
  }
  return code;
}
