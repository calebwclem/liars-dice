import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The property tests play whole matches rather than exercising a function, so they are
    // seconds-scale by nature. Vitest's 5s default is a unit-test ceiling, and on shared CI
    // hardware — two to three times slower than a laptop — it turns a passing test into a coin
    // flip. This is a stop for a genuine hang, not a performance budget.
    testTimeout: 30_000,
    // Rule-ID coverage is checked by test/coverage.test.ts, which reads the other
    // test files and asserts every R-nn in docs/RULES.md appears in a test name.
    reporters: ['default'],
  },
});
