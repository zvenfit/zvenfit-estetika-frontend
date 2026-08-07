module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'script',
  },
  extends: ['eslint:recommended'],
  globals: {
    IMask: 'readonly',
  },
  rules: {
    curly: 'error',
    eqeqeq: ['error', 'smart'],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
  ignorePatterns: ['dist/', 'node_modules/', 'upload/', '.cdn-upload/', 'public/js/webflow.js'],
  overrides: [
    {
      files: ['mock-server.js', 'scripts/watch-static.cjs', 'scripts/build-static.cjs', 'scripts/prepare-cdn-assets.cjs'],
      rules: {
        'no-console': 'off',
      },
    },
  ],
};
