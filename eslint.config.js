import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      '**/dist/',
      '**/node_modules/',
      'packages/docs/',
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
      '**/*.d.ts',
    ],
  },

  // Base JS rules
  eslint.configs.recommended,

  // TypeScript strict rules (non-type-aware — tsc handles type safety separately)
  ...tseslint.configs.strict,

  // Prettier compat (disables formatting rules that conflict)
  eslintConfigPrettier,

  // Project rules
  {
    rules: {
      // Rule 5: No any
      '@typescript-eslint/no-explicit-any': 'error',

      // This root config is intentionally non-type-aware. Keep typed-only rules
      // in the typecheck lane instead of requiring parser project services here.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',

      // Rule 5: Restrict type assertions — only allow `as` style, ban on object literals
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        {
          assertionStyle: 'as',
          objectLiteralTypeAssertions: 'never',
        },
      ],

      // Rule 9: Uniform naming conventions
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'variable',
          format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'function',
          format: ['camelCase', 'PascalCase'],
        },
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },
        {
          selector: 'enumMember',
          format: ['PascalCase', 'UPPER_CASE'],
        },
      ],

      // Allow void expressions for fire-and-forget
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },

  // Test files — relax some rules
  {
    files: ['**/tests/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
