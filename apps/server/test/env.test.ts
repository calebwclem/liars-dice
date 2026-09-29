import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadEnvFile } from '../src/env.ts';

/**
 * Reading `.env`, and who wins.
 *
 * This moved out of a `--env-file-if-exists` flag on the dev script, which printed its "not
 * found" notice twice because `node --watch` runs a supervisor and a child and both parse the
 * flag. Moving it here has to keep the flag's semantics, which is what these pin down: the real
 * environment beats the file, and a missing file is not an error.
 */
const TOUCHED = ['LIARS_DICE_TEST_FROM_FILE', 'LIARS_DICE_TEST_FROM_SHELL'] as const;

afterEach(() => {
  // `Reflect.deleteProperty` rather than `delete process.env[key]`: the lint rule against a
  // dynamic `delete` is about the hidden-class cost of it, and this is the sanctioned spelling.
  for (const key of TOUCHED) Reflect.deleteProperty(process.env, key);
});

async function envFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'liarsdice-env-'));
  const path = join(dir, '.env');
  await writeFile(path, contents);
  return path;
}

describe('The .env file', () => {
  test('a variable only the file sets is picked up', async () => {
    const path = await envFile('LIARS_DICE_TEST_FROM_FILE=yes\n');
    loadEnvFile(path);
    expect(process.env['LIARS_DICE_TEST_FROM_FILE']).toBe('yes');
  });

  test('a real environment variable beats the file', async () => {
    // Production is configured entirely from the environment. A checked-out `.env` quietly
    // overriding it would be the worst kind of surprise.
    process.env['LIARS_DICE_TEST_FROM_SHELL'] = 'from the shell';
    const path = await envFile('LIARS_DICE_TEST_FROM_SHELL=from the file\n');
    loadEnvFile(path);
    expect(process.env['LIARS_DICE_TEST_FROM_SHELL']).toBe('from the shell');
  });

  test('no file at all is a normal way to run', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'liarsdice-env-')), 'nothing-here');
    expect(() => {
      loadEnvFile(path);
    }).not.toThrow();
  });
});

describe('Configuration', () => {
  test('an empty environment still boots, with a throwaway secret', () => {
    const config = loadConfig({ NODE_ENV: 'development' });
    expect(config.PORT).toBe(8080);
    expect(config.AUTH_SECRET.length).toBeGreaterThanOrEqual(16);
    // R-16 and R-18 are rules, not preferences; the defaults have to be the rule.
    expect(config.TURN_MS).toBe(30_000);
    expect(config.RECONNECT_GRACE_MS).toBe(45_000);
  });

  test('production refuses to start without a signing secret', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/AUTH_SECRET/);
  });

  test('a malformed value is a startup failure naming the variable', () => {
    expect(() => loadConfig({ NODE_ENV: 'development', PORT: 'ten' })).toThrow(/PORT/);
  });
});
