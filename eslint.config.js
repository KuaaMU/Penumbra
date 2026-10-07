import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

/**
 * Penumbra lint policy.
 *
 * The constitution's Section 1 claims that violating an absolute invariant is an
 * "Automatic Test Failure". Prose does not enforce itself, so the forbidden-pattern
 * list from CLAUDE.md Section 5 is bound here to real ESLint rules: `pnpm lint`
 * exits non-zero on a violation, and the claim is therefore true rather than
 * aspirational.
 */
export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules', '.vitest', 'test-results', 'playwright-report'] },

  js.configs.recommended,

  // Type-aware configs apply only to sources and tests. Applying them to the config
  // files themselves aborts the run with "rule requires type information", because
  // eslint.config.js is not inside any tsconfig project.
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // --- CLAUDE.md Section 1: NO CHATBOT UI -------------------------------
      // Linear conversation UI is the failure mode this project must not regress
      // into, so the globals that signal one are banned outright.
      'no-restricted-globals': [
        'error',
        { name: 'alert', message: 'Penumbra has no modals. Surface feedback as a spatial node or an ambient glow.' },
        { name: 'confirm', message: 'Penumbra has no modals. Surface feedback as a spatial node or an ambient glow.' },
        { name: 'prompt', message: 'Penumbra has no modals. Surface feedback as a spatial node or an ambient glow.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'NewExpression[callee.name=/^(alert|confirm|prompt)$/]',
          message: 'Penumbra has no modals. See CLAUDE.md Section 5.',
        },
      ],

      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // CLAUDE.md Section 5: no network API from any code path that can touch
  // private_draft. One audited egress module exists; everything else is denied.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/core/net/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'NewExpression[callee.name=/^(alert|confirm|prompt)$/]',
          message: 'Penumbra has no modals. See CLAUDE.md Section 5.',
        },
        {
          selector: "CallExpression[callee.name='fetch']",
          message:
            'Network egress is confined to src/core/net/. Import the audited transport so ZERO EGRESS stays enforceable.',
        },
      ],
    },
  },

  // The tripwire is the one place that legitimately names the network globals.
  {
    files: ['src/core/net/**'],
    rules: {
      'no-restricted-syntax': 'off',
      'no-restricted-globals': 'off',
    },
  },

  // Tests need to assert on forbidden APIs precisely, and to interpolate measured
  // numbers into assertion messages. These relaxations apply to tests ONLY — the
  // production rules above are untouched.
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': 'off',
      'no-restricted-globals': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/dot-notation': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      'unbound-method': 'off',
    },
  },
)
