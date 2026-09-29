import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },

  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  prettier,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Discriminated unions are the backbone of Action/GameEvent; a missing case must
      // be a compile-time and lint-time error, not a silent fallthrough.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      // The engine returns errors as values; exceptions are for programmer bugs only.
      '@typescript-eslint/only-throw-error': 'error',
      'no-console': 'error',
    },
  },

  {
    // CLAUDE.md rule 3: the engine is pure. No ambient time, no ambient randomness, no I/O. Time
    // and randomness arrive through Ctx. The linter enforces it so a future edit cannot quietly
    // reintroduce impurity — see also the R-20 tests, which stub Math.random and Date.now to throw.
    //
    // The same applies to the bots: a policy that reached for Math.random would still play, but it
    // would stop replaying, and a match you cannot reproduce is a match you cannot debug.
    files: ['packages/engine/src/**/*.ts', 'packages/bots/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'The engine is pure: take the clock from Ctx.now.' },
        { name: 'process', message: 'The engine is pure: no process access.' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'The engine is pure: take randomness from Ctx.rng.',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'The engine is pure: take the clock from Ctx.now.',
        },
      ],
    },
  },

  {
    // The CLI is an impure entry point by design: it owns stdio, the real clock, and the seed.
    files: ['apps/cli/src/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  {
    // The browser client. Three rules that are right for a Node service and wrong for JSX:
    //
    //  - `no-confusing-void-expression` exists to catch an accidental `return doThing()`. Every
    //    React event handler is exactly that shape on purpose, and wrapping a few hundred of them
    //    in braces would be noise, not safety.
    //  - `no-misused-spread` warns that `[...string]` splits by code point rather than grapheme.
    //    True, and irrelevant: the only strings spread here are party codes, whose alphabet is
    //    32 ASCII characters by construction.
    //  - `switch-exhaustiveness-check` still applies, but a `default` branch is allowed to satisfy
    //    it. `ErrorCode` is a 30-case union where most cases share one sentence of copy; listing
    //    every one would make the readable ones harder to find.
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-misused-spread': 'off',
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { allowDefaultCaseForExhaustiveSwitch: true, considerDefaultExhaustiveForUnions: true },
      ],
    },
  },

  {
    // This file belongs to no tsconfig, so there is no type information for it. Lint it
    // for syntax only rather than inventing a project just to cover the linter's config.
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  {
    files: ['**/*.test.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
);
