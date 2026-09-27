module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: ['out/**', 'dist/**', 'media/**', 'node_modules/**', 'coverage/**', '*.js'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    eqeqeq: ['error', 'smart'],
    curly: ['error', 'multi-line'],
  },
  overrides: [
    {
      files: ['scripts/**/*.mjs', 'scripts/**/*.js'],
      parser: 'espree',
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      plugins: [],
      extends: ['eslint:recommended'],
      rules: {
        '@typescript-eslint/no-var-requires': 'off',
      },
    },
    {
      files: ['src/webview/client/**/*.ts'],
      rules: {
        'no-console': 'off',
      },
    },
  ],
};
