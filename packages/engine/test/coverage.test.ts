import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * A test about the tests: every rule in docs/RULES.md must be named by at least one test,
 * and every rule the engine does *not* implement must be declared as such. Without this,
 * "we covered the ruleset" is a claim nobody re-checks after the first week.
 */
const TEST_DIR = import.meta.dirname;
const RULES_PATH = join(TEST_DIR, '..', '..', '..', 'docs', 'RULES.md');

/** Rules deliberately not covered by an implemented test, with the reason. */
const DECLARED_GAPS = new Map<string, string>([
  ['R-16', 'turn timer — Phase 2, the server owns the clock'],
  ['R-17', 'timeout auto-bid and AFK takeover — Phase 2'],
  ['R-18', 'reconnect grace — Phase 2'],
  ['R-19', 'abandonment — Phase 2'],
  ['R-21', 'provable fairness — marked v1.1 in docs/RULES.md, out of scope for v1'],
]);

/** Rules that must have a real, running test — everything else in the document. */
const ruleIds = (): string[] => {
  const doc = readFileSync(RULES_PATH, 'utf8');
  return [...new Set([...doc.matchAll(/\*\*(R-\d{2})\*\*/g)].map((m) => m[1]!))].sort();
};

interface TestName {
  readonly name: string;
  readonly todo: boolean;
  readonly file: string;
}

const testNames = (): TestName[] => {
  const out: TestName[] = [];
  for (const file of readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.ts'))) {
    const source = readFileSync(join(TEST_DIR, file), 'utf8');
    const pattern = /\b(test|it|describe)(\.todo|\.skip|\.each)?\(\s*(['"`])([^'"`]+)/g;
    for (const match of source.matchAll(pattern)) {
      out.push({ name: match[4]!, todo: match[2] === '.todo', file });
    }
  }
  return out;
};

const citedIn = (names: readonly TestName[], id: string): TestName[] =>
  names.filter((t) => t.name.includes(id));

describe('Rule coverage', () => {
  // This file's own test names must not cite a rule ID: the scanner reads every test
  // name in the directory, including these, and a citation here would register as
  // coverage.
  test('the document is readable and its rules are numbered in an unbroken sequence', () => {
    const ids = ruleIds();
    expect(ids[0]).toBe('R-01');
    expect(ids).toHaveLength(21);
    expect(ids).toEqual(
      Array.from({ length: 21 }, (_, i) => `R-${String(i + 1).padStart(2, '0')}`),
    );
  });

  test('every rule ID appears in at least one test name', () => {
    const names = testNames();
    const missing = ruleIds().filter((id) => citedIn(names, id).length === 0);
    expect(missing, 'rules with no test naming them').toEqual([]);
  });

  test('every rule is either implemented or a declared gap — nothing is quietly skipped', () => {
    const names = testNames();
    const unimplemented = ruleIds().filter((id) => citedIn(names, id).every((t) => t.todo));
    expect(unimplemented.sort()).toEqual([...DECLARED_GAPS.keys()].sort());
  });

  test('the declared gaps are still gaps, and still declared', () => {
    const names = testNames();
    for (const [id, why] of DECLARED_GAPS) {
      const cited = citedIn(names, id);
      expect(cited.length, `${id} (${why}) should be named somewhere`).toBeGreaterThan(0);
      expect(
        cited.some((t) => t.todo),
        `${id} (${why}) should be a todo until it is implemented`,
      ).toBe(true);
    }
  });
});
