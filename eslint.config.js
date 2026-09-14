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
    // CLAUDE.md rule 3: the engine is pure. No ambient time, no ambient randomness, no
    // I/O. Time and randomness arrive through Ctx. The linter enforces it so a future
    // edit cannot quietly reintroduce impurity — see also the R-20 tests, which stub
    // Math.random and Date.now to throw.
    files: ['packages/engine/src/**/*.ts'],
    ignores: ['packages/engine/src/cli.ts'],
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
    // The CLI is the one impure entry point: it owns stdio, the real clock, and the seed.
    files: ['packages/engine/src/cli.ts'],
    rules: { 'no-console': 'off' },
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
