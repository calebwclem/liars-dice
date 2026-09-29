import { defineConfig } from 'vitest/config';

/**
 * Two projects, on purpose.
 *
 * The session is deliberately DOM-free — it takes its socket rather than building one — so most
 * tests run under plain node, and keeping them there is what stops a DOM dependency creeping in
 * unnoticed. The files under `test/dom/` mount the real component tree and get happy-dom,
 * because the bugs worth catching there only appear once React is mounting and unmounting
 * things for itself.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['test/*.test.{ts,tsx}'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'dom',
          include: ['test/dom/**/*.test.{ts,tsx}'],
          environment: 'happy-dom',
          setupFiles: ['test/dom/setup.ts'],
        },
      },
    ],
  },
});
