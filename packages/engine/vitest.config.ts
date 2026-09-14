import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Rule-ID coverage is checked by test/coverage.test.ts, which reads the other
    // test files and asserts every R-nn in docs/RULES.md appears in a test name.
    reporters: ['default'],
  },
});
