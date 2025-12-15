import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        project: './tsconfig.json',
      },
    },
  },
  {
    rules: {
      // Code complexity (relaxed for Lambda)
      complexity: ['warn', 15],
      'max-lines': ['warn', 400],
      'max-depth': ['error', 4],
      'max-params': ['warn', 6],

      // Best practices
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      curly: ['error', 'all'],
      'no-shadow': 'off',
    },
  },
  {
    rules: {
      // TypeScript specific
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    ignores: ['node_modules', 'dist', 'coverage', '*.js', '*.cjs'],
  },
);
