import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Runnable examples are Node scripts.
    files: ['examples/**/*.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
  },
  {
    // Financial code paths: money is bigint minor units. Floating-point
    // construction and float literals are banned outright (PLAN.md §3.4).
    files: ['packages/core/src/**/*.ts', 'packages/storage/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[raw=/^\\d+\\.\\d+$/]',
          message:
            'Float literals are banned in financial code. Use bigint minor units (see docs/adr/0002-integer-money.md).',
        },
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: 'parseFloat is banned in financial code. Use parseMoney from @accounts/core.',
        },
        {
          selector:
            "CallExpression[callee.object.name='Number'][callee.property.name='parseFloat']",
          message: 'Number.parseFloat is banned in financial code. Use parseMoney from @accounts/core.',
        },
      ],
    },
  },
);
