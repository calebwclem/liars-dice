import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';

/**
 * The CLI is the Phase 1 done-criterion: it must play a complete match to a winner. That
 * claim belongs in CI rather than in a paragraph, so this runs the real program end to
 * end. `--auto` hands the human seat to a bot; every other path through the program is the
 * same one a person drives.
 */
const run = promisify(execFile);
const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const play = (...args: string[]) => run(process.execPath, [CLI, ...args], { timeout: 60_000 });
/**
 * Strip ANSI so assertions read the text rather than the colour codes. The escape
 * character is the whole point here, so no-control-regex is off for this line only.
 */
// eslint-disable-next-line no-control-regex
const plain = (s: string): string => s.replace(/\u001b\[\d+m/g, '');

describe('CLI', () => {
  test('plays a full four-player match through to a winner', async () => {
    const { stdout } = await play('--auto', '--seed', '11');
    const out = plain(stdout);
    expect(out).toMatch(/(You win\.|Bot \d wins\.)/);
    expect(out).toContain('Reveal');
    expect(out).toMatch(/\d+ rounds, \d+ actions, seed 11/);
    // Somebody was eliminated along the way: a four-player match cannot end otherwise.
    expect(out).toMatch(/(is|are) out/);
  }, 60_000);

  test('the same seed replays the same match', async () => {
    const [first, second] = await Promise.all([
      play('--auto', '--seed', '4242'),
      play('--auto', '--seed', '4242'),
    ]);
    // The clock differs between runs (ctx.now is Date.now here), but nothing the players
    // see depends on it, so the transcripts must match exactly.
    expect(plain(second.stdout)).toBe(plain(first.stdout));
  }, 60_000);

  test('R-01: it seats two through six players', async () => {
    for (const players of ['2', '6']) {
      const { stdout } = await play('--auto', '--seed', '5', '--players', players);
      expect(plain(stdout)).toContain(`${players} players, 5 dice each`);
      expect(plain(stdout)).toMatch(/(You win\.|Bot \d wins\.)/);
    }
  }, 60_000);

  test('R-01: it refuses a table that breaks the player limit', async () => {
    // execFile rejects with the exit status; the reason code is on the captured stdout,
    // because the engine returned it as a value rather than throwing.
    interface Failure {
      readonly code?: number;
      readonly stdout?: string;
    }
    const failure: Failure = await play('--auto', '--players', '7').catch(
      (e: unknown) => e as Failure,
    );
    expect(failure.code).toBe(1);
    expect(plain(failure.stdout ?? '')).toContain('INVALID_PLAYER_COUNT');
  }, 60_000);

  test('a human can bid, be told why a bid is illegal, and quit', async () => {
    const child = run(process.execPath, [CLI, '--seed', '11'], { timeout: 60_000 });
    child.child.stdin?.end('?\nl\n99 6\n1 7\n3 4\nq\n');
    const out = plain((await child).stdout);
    expect(out).toContain('legal raises, weakest first');
    expect(out).toContain('rejected: BID_EXCEEDS_DICE_IN_PLAY');
    expect(out).toContain('only 20 dice are in play');
    expect(out).toContain('rejected: BID_FACE_INVALID');
    expect(out).toContain('bye');
    // The human's own hand is shown as faces; every other seat only as a count.
    expect(out).toMatch(/You {4}[⚀⚁⚂⚃⚄⚅ ]+\(5\)/);
    expect(out).toMatch(/Bot 1 {2}(▪ ){4}▪ \(5\)/);
  }, 60_000);

  test('R-06: the opening player is told to bid rather than challenge', async () => {
    const child = run(process.execPath, [CLI, '--seed', '11'], { timeout: 60_000 });
    child.child.stdin?.end('d\nq\n');
    const out = plain((await child).stdout);
    expect(out).toContain('you must bid');
  }, 60_000);
});
