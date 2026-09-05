// ESLint v9 flat config — type-aware. parserOptions.project enables
// rules that need the type checker (no-floating-promises,
// no-misused-promises, no-unsafe-*, etc.); the single-pass cost is
// acceptable for a project this size.
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'src/admin/app.js', 'src/admin/vendor/**', 'src/plugins/**/ui/**'] },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...tsPlugin.configs['recommended-type-checked'].rules,
      // Allow `_unused` and `_unused: foo` patterns — common in our handlers.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_',
      }],
      // Strict: explicit `any` requires a per-line disable with a written
      // justification. The two sites that need it (the generic transaction
      // signature in src/db.ts) both have inline disables + comments.
      '@typescript-eslint/no-explicit-any': 'error',
      // node:test's describe/it/test all return Promise<void> by spec but
      // the runner manages them — they're "safe" to not await. Allowlist
      // the framework calls so we still catch real floating promises elsewhere.
      '@typescript-eslint/no-floating-promises': ['error', {
        allowForKnownSafeCalls: [
          { from: 'package', name: 'describe',    package: 'node:test' },
          { from: 'package', name: 'it',          package: 'node:test' },
          { from: 'package', name: 'test',        package: 'node:test' },
          { from: 'package', name: 'before',      package: 'node:test' },
          { from: 'package', name: 'after',       package: 'node:test' },
          { from: 'package', name: 'beforeEach',  package: 'node:test' },
          { from: 'package', name: 'afterEach',   package: 'node:test' },
        ],
      }],
      // Express's `app.get('/x', async (req, res) => {...})` returns a
      // promise but the express runtime handles it correctly; the TS
      // types just don't reflect that. `checksVoidReturn: false` stops
      // the rule from firing on those handlers. The other half of
      // no-misused-promises (promise in a boolean) is still checked.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      // Off: async signatures without an internal await are common for
      // mock impls and interface conformance (every dispatcher returns a
      // promise even if a particular one is synchronous). False-positive heavy.
      '@typescript-eslint/require-await': 'off',
    },
  },
];
