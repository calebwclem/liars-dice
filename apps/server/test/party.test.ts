import { describe, expect, test } from 'vitest';
import { PARTY_CODE_ALPHABET, PARTY_CODE_LENGTH } from '@liars-dice/protocol';
import { Parties, type PartyView } from '../src/party.ts';
import { silentLogger } from '../src/logger.ts';
import type { SeatSpec } from '../src/room.ts';

interface Started {
  readonly matchId: string;
  readonly seats: readonly SeatSpec[];
}

/**
 * A registry with predictable codes. Real codes are random; a test that had to guess one
 * would be testing the generator rather than the party.
 */
function parties(options: { codes?: readonly string[]; matchSize?: number } = {}) {
  const started: Started[] = [];
  const broadcasts: PartyView[] = [];
  const codes = [...(options.codes ?? ['AAAA', 'BBBB', 'CCCC', 'DDDD'])];
  let issued = 0;
  const registry = new Parties({
    matchSize: options.matchSize ?? 4,
    log: silentLogger(),
    newCode: () => codes[issued++] ?? `Z${String(issued).padStart(3, '0')}`,
    newMatchId: () => `m_${String(started.length)}`,
    onStart: (matchId, seats) => {
      started.push({ matchId, seats });
    },
    onChanged: (view) => {
      broadcasts.push(view);
    },
  });
  return { registry, started, broadcasts };
}

/** `create`, `join` and `partyOf` return a view, an error code, or nothing; tests want the view. */
function view(result: PartyView | string | undefined): PartyView {
  if (result === undefined) throw new Error('expected a party, got nothing');
  if (typeof result === 'string') throw new Error(`expected a party, got ${result}`);
  return result;
}

describe('Creating and joining a party', () => {
  test('creating one makes you the host and the only member', () => {
    const { registry } = parties();
    const party = view(registry.create('a'));
    expect(party.code).toBe('AAAA');
    expect(party.hostId).toBe('a');
    expect(party.members).toEqual(['a']);
  });

  test('a real code is four characters from an alphabet with no confusable glyphs', () => {
    // The point of the alphabet is that a code can be read aloud. O/0 and I/1 are the pairs
    // that ruin that, so neither appears.
    const registry = new Parties({
      matchSize: 4,
      log: silentLogger(),
      onStart: () => undefined,
      onChanged: () => undefined,
    });
    expect(PARTY_CODE_ALPHABET).not.toMatch(/[O01I]/);
    for (let i = 0; i < 200; i += 1) {
      const party = view(registry.create(`p${String(i)}`));
      expect(party.code).toHaveLength(PARTY_CODE_LENGTH);
      for (const character of party.code) {
        expect(PARTY_CODE_ALPHABET, `"${character}" is not in the alphabet`).toContain(character);
      }
    }
  });

  test('joining with the code puts you in, in join order', () => {
    const { registry } = parties();
    registry.create('a');
    expect(view(registry.join('b', 'AAAA')).members).toEqual(['a', 'b']);
    expect(view(registry.join('c', 'AAAA')).members).toEqual(['a', 'b', 'c']);
  });

  test('an unknown code is refused rather than silently creating one', () => {
    const { registry } = parties();
    expect(registry.join('a', 'ZZZZ')).toBe('UNKNOWN_PARTY');
  });

  test('you can only be in one party, by joining or by creating', () => {
    const { registry } = parties();
    registry.create('a');
    registry.join('b', 'AAAA');
    expect(registry.join('b', 'AAAA')).toBe('ALREADY_IN_PARTY');
    expect(registry.create('b')).toBe('ALREADY_IN_PARTY');
  });

  test('R-01: a party fills up at six and refuses the seventh', () => {
    const { registry } = parties();
    registry.create('a');
    for (const id of ['b', 'c', 'd', 'e', 'f'])
      expect(registry.join(id, 'AAAA')).not.toBe('PARTY_FULL');
    expect(view(registry.partyOf('a')).members).toHaveLength(6);
    expect(registry.join('g', 'AAAA')).toBe('PARTY_FULL');
  });

  test('a code in use is never handed out twice', () => {
    // The generator is random, so collisions are rare but not impossible. Forcing one is the
    // only way to know the retry works.
    const { registry } = parties({ codes: ['AAAA', 'AAAA', 'AAAA', 'BBBB'] });
    expect(view(registry.create('a')).code).toBe('AAAA');
    expect(view(registry.create('b')).code).toBe('BBBB');
  });

  test('every change is broadcast to the party as a whole state', () => {
    const { registry, broadcasts } = parties();
    registry.create('a');
    registry.join('b', 'AAAA');
    registry.leave('b');
    expect(broadcasts.map((party) => party.members)).toEqual([['a'], ['a', 'b'], ['a']]);
  });
});

describe('Leaving a party', () => {
  test('leaving removes you and tells the rest', () => {
    const { registry } = parties();
    registry.create('a');
    registry.join('b', 'AAAA');
    expect(registry.leave('b')).toBe(true);
    expect(view(registry.partyOf('a')).members).toEqual(['a']);
    expect(registry.partyOf('b')).toBeUndefined();
  });

  test('leaving something you are not in is not an error, just nothing', () => {
    const { registry } = parties();
    expect(registry.leave('nobody')).toBe(false);
  });

  test('the host leaving hands the party to whoever is next', () => {
    // Dissolving the party instead would punish everyone for one person's connection
    // dropping — and a disconnect is exactly how most hosts will leave.
    const { registry } = parties();
    registry.create('a');
    registry.join('b', 'AAAA');
    registry.join('c', 'AAAA');
    registry.leave('a');
    const party = view(registry.partyOf('b'));
    expect(party.hostId).toBe('b');
    expect(party.members).toEqual(['b', 'c']);
  });

  test('the last member leaving dissolves it and frees the code', () => {
    const { registry } = parties();
    registry.create('a');
    registry.leave('a');
    expect(registry.join('b', 'AAAA')).toBe('UNKNOWN_PARTY');
  });
});

describe('Starting the match', () => {
  test('only the host may start it', () => {
    const { registry } = parties();
    registry.create('a');
    registry.join('b', 'AAAA');
    expect(registry.start('b', false)).toBe('NOT_PARTY_HOST');
    expect(registry.start('a', false)).toBeNull();
  });

  test('starting one you are not in is refused', () => {
    const { registry } = parties();
    expect(registry.start('nobody', false)).toBe('NOT_IN_PARTY');
  });

  test('R-01: a party of one cannot start a match', () => {
    const { registry } = parties();
    registry.create('a');
    expect(registry.start('a', true)).toBe('PARTY_TOO_SMALL');
  });

  test('two humans and no bots plays exactly those two', () => {
    // R-01 allows 2, and two friends wanting a head-to-head should not be given bots.
    const { registry, started } = parties();
    registry.create('a');
    registry.join('b', 'AAAA');
    expect(registry.start('a', false)).toBeNull();
    expect(started).toHaveLength(1);
    expect(started[0]?.seats).toEqual([
      { playerId: 'a', kind: 'human' },
      { playerId: 'b', kind: 'human' },
    ]);
  });

  test('filling with bots tops the table up to a normal match size', () => {
    const { registry, started } = parties({ matchSize: 4 });
    registry.create('a');
    registry.join('b', 'AAAA');
    expect(registry.start('a', true)).toBeNull();
    const seats = started[0]?.seats ?? [];
    expect(seats).toHaveLength(4);
    expect(seats.filter((seat) => seat.kind === 'human').map((seat) => seat.playerId)).toEqual([
      'a',
      'b',
    ]);
    expect(seats.filter((seat) => seat.kind === 'bot')).toHaveLength(2);
  });

  test('a party larger than the match size seats everyone and adds nobody', () => {
    const { registry, started } = parties({ matchSize: 4 });
    registry.create('a');
    for (const id of ['b', 'c', 'd', 'e']) registry.join(id, 'AAAA');
    expect(registry.start('a', true)).toBeNull();
    const seats = started[0]?.seats ?? [];
    expect(seats).toHaveLength(5);
    expect(seats.every((seat) => seat.kind === 'human')).toBe(true);
  });

  test('starting dissolves the party — the code stops working', () => {
    const { registry } = parties();
    registry.create('a');
    registry.join('b', 'AAAA');
    registry.start('a', false);
    expect(registry.partyOf('a')).toBeUndefined();
    expect(registry.join('c', 'AAAA')).toBe('UNKNOWN_PARTY');
  });
});
