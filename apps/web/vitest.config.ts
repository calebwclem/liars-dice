import { defineConfig } from 'vitest/config';

/**
 * The session is deliberately DOM-free — it takes its socket rather than building one — so the
 * default node environment is enough and no jsdom dependency is needed to test it.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
