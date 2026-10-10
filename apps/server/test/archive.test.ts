import { describe, expect, test } from 'vitest';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileArchive, noArchive, type MatchTranscript } from '../src/archive.ts';
import { silentLogger } from '../src/logger.ts';

/**
 * Writing a finished match down.
 *
 * The transcript's *contents* are checked against a real match in `integration.test.ts`, which
 * is the only place one actually gets played. This covers the writing: that a file appears, that
 * it is complete when it does, and that a server which cannot write one carries on regardless.
 */
const transcript = (matchId: string): MatchTranscript => ({
  matchId,
  status: 'ended',
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_060_000,
  winnerId: 'a',
  seats: [
    { playerId: 'a', kind: 'human' },
    { playerId: 'b', kind: 'bot' },
  ],
  config: { startingDice: 5, maxDice: 5 },
  actions: [
    { type: 'bid', playerId: 'a', bid: { quantity: 2, face: 6 } },
    { type: 'dudo', playerId: 'b' },
    { type: 'advanceRound' },
  ],
  transitions: [
    { seq: 1, events: [{ type: 'matchStarted', playerIds: ['a', 'b'], startingDice: 5 }] },
  ],
});

/** `record` is fire-and-forget, so give its promise a turn of the loop to land. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe('The match archive', () => {
  test('a finished match becomes one JSON file named after it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'liarsdice-archive-'));
    fileArchive(dir, silentLogger()).record(transcript('M1'));
    await settle();

    const written = await readFile(join(dir, 'M1.json'), 'utf8');
    const parsed = JSON.parse(written) as MatchTranscript;
    expect(parsed.matchId).toBe('M1');
    expect(parsed.winnerId).toBe('a');
    expect(parsed.actions).toHaveLength(3);
    // The point of the file: the actions, in order, ready to go back through `reduce`.
    expect(parsed.actions[0]).toEqual({
      type: 'bid',
      playerId: 'a',
      bid: { quantity: 2, face: 6 },
    });
  });

  test('a reader never sees half a transcript', async () => {
    // Written to a temporary name and renamed, so the final path either does not exist or is a
    // whole file. A plain write to the final path is observable mid-flight.
    const dir = await mkdtemp(join(tmpdir(), 'liarsdice-archive-'));
    const archive = fileArchive(dir, silentLogger());
    for (const id of ['M1', 'M2', 'M3']) archive.record(transcript(id));
    await settle();

    const files = (await readdir(dir)).sort();
    expect(files).toEqual(['M1.json', 'M2.json', 'M3.json']);
    expect(files.some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  test('the directory is created rather than required', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'liarsdice-archive-')), 'deep', 'nested');
    fileArchive(dir, silentLogger()).record(transcript('M1'));
    await settle();
    expect(await readdir(dir)).toEqual(['M1.json']);
  });

  test('a server that cannot write its archive is still a server', async () => {
    // The disk is full, the path is a file, the permissions are wrong. None of that is worth
    // taking a match down for, and the room calls this on the way out of a win.
    const parent = await mkdtemp(join(tmpdir(), 'liarsdice-archive-'));
    const blocked = join(parent, 'in-the-way');
    await writeFile(blocked, 'not a directory');

    expect(() => {
      fileArchive(blocked, silentLogger()).record(transcript('M1'));
    }).not.toThrow();
    // And the failure does not surface as an unhandled rejection either.
    await settle();
  });

  test('no archive configured keeps nothing and says nothing', () => {
    expect(() => {
      noArchive().record(transcript('M1'));
    }).not.toThrow();
  });
});
