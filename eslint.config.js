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

  // TypeScript strict + type-aware rules
  ...tseslint.configs.strictTypeChecked,

  // Prettier compat (disables formatting rules that conflict)
  eslintConfigPrettier,

  // TypeScript parser config
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Project rules
  {
    rules: {
      // Rule 5: No any
      '@typescript-eslint/no-explicit-any': 'error',

      // Rule 5: No unnecessary casts
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',

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

      // Strict type-checked rules we want to relax slightly
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],

      // Allow void expressions for fire-and-forget
      '@typescript-eslint/no-confusing-void-expression': 'off',

      // Too noisy for a framework with many callback patterns
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
    },
  },

  // Test files — relax some rules
  {
    files: ['**/tests/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Mock methods are commonly accessed without binding in tests
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
