import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Rooms own timers; a hung test should fail loudly rather than stall CI.
    testTimeout: 30_000,
  },
});
