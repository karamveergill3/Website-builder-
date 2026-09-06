export default [
  {
    files: ['server/**/*.js', 'public/js/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly', process: 'readonly', fetch: 'readonly', Buffer: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', Response: 'readonly', URLSearchParams: 'readonly',
        document: 'readonly', window: 'readonly', location: 'readonly',
        navigator: 'readonly', FormData: 'readonly', localStorage: 'readonly',
        HTMLElement: 'readonly', Element: 'readonly', URL: 'readonly',
        AbortController: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': 'error',
      'no-self-assign': 'error',
      'no-dupe-else-if': 'error',
      'require-atomic-updates': 'warn',
    },
  },
];
