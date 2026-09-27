'use strict'

module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    // Type-aware linting. Without this the rules below that need types cannot
    // run at all, and "no unhandled promise rejections" stays a review-only
    // rule rather than one the tooling enforces.
    project: ['./tsconfig.node.json', './tsconfig.web.json'],
    tsconfigRootDir: __dirname,
  },
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  rules: {
    'no-console': 'warn',
    // CLAUDE.md makes unhandled rejections a hard requirement; these are the
    // two rules that can actually enforce it.
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
  ignorePatterns: ['out/', 'dist/', 'node_modules/'],
}
