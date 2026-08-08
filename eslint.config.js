import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import prettier from 'eslint-config-prettier'

export default defineConfig(
  {
    // R2: Trellis-managed paths are off-limits to app tooling.
    // Also excluded in tsconfig.base.json — two layers, because one is a
    // single point of failure. See .trellis/spec/backend/quality-guidelines.md
    ignores: [
      '.trellis/**',
      '.claude/**',
      '.codex/**',
      '.qoder/**',
      '.agents/**',
      '**/dist/**',
      '**/out/**',
      '**/node_modules/**',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Forbidden by spec: `any` defeats the reason zod is here.
      '@typescript-eslint/no-explicit-any': 'error',
      // `!` to silence the compiler. Permitted only with an enforced invariant
      // immediately above — hence 'warn' not 'error', reviewed case by case.
      '@typescript-eslint/no-non-null-assertion': 'warn',
      // Bare throws can't be branched on, translated, or asserted.
      '@typescript-eslint/only-throw-error': 'error',
      // Conflicts with noUncheckedIndexedAccess on process.env: dot access
      // there is not actually safer, and bracket access is the correct idiom.
      '@typescript-eslint/dot-notation': [
        'error',
        { allowIndexSignaturePropertyAccess: true },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  {
    // packages/core must stay Electron-free so it is testable under plain Node
    // and reusable by the website. See backend/directory-structure.md.
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'packages/core must stay Electron-free (testable headless, reusable by apps/web). Move this to apps/desktop/src/main.',
            },
          ],
          patterns: [
            {
              group: ['electron/*', 'electron-*'],
              message: 'packages/core must stay Electron-free.',
            },
          ],
        },
      ],
    },
  },

  {
    // packages/shared holds contracts only. zod is its sole dependency.
    files: ['packages/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron', message: 'packages/shared is contracts only.' },
            {
              name: '@gomentor/core',
              message:
                'packages/shared must not depend on core — the dependency runs the other way.',
            },
          ],
        },
      ],
    },
  },

  {
    // The renderer is presentation only. contextIsolation is on and
    // nodeIntegration is off, so these imports fail at runtime anyway —
    // reaching for them means the work belongs in the main process.
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'The renderer must not import electron. Use the window.gomentor bridge.',
            },
          ],
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'child_process', 'os', 'crypto'],
              message:
                'No Node APIs in the renderer. Route through the preload bridge to the main process.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'require', message: 'No CommonJS require in the renderer.' },
        { name: 'process', message: 'No process access in the renderer.' },
      ],
      // A raw ipcRenderer handle in the page is a sandbox escape.
      'no-restricted-properties': [
        'error',
        {
          object: 'window',
          property: 'ipcRenderer',
          message:
            'window.ipcRenderer is a sandbox escape. The only bridge is window.gomentor.',
        },
      ],
    },
  },

  {
    // Raw channel strings drift silently on rename. ipc.ts is the one contract.
    files: ['apps/desktop/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'Literal[value=/^(sgf|library|llm|settings|katago|profile|kb|update):[a-zA-Z]+$/]',
          message:
            'Do not inline IPC channel strings. Import the channel from @gomentor/shared/ipc.',
        },
      ],
    },
  },

  {
    // Build/tool config files live outside the app tsconfigs. Point them at
    // tsconfig.tools.json explicitly — routing them to the default project
    // instead silently drops strictNullChecks and disables every type-aware
    // rule, which looks like it works but checks nothing.
    files: [
      'eslint.config.js',
      'vitest.config.ts',
      '**/vitest.config.ts',
      '**/electron.vite.config.ts',
      // `.mts` as well as `.ts`: tool scripts run through `tsx` as ES modules,
      // and a bare `*.ts` glob leaves them on the default project, where every
      // type-aware rule silently becomes a no-op.
      'scripts/**/*.{ts,mts}',
    ],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './tsconfig.tools.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  {
    files: ['**/*.{test,spec}.{ts,tsx}', '**/test/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },

  {
    files: ['scripts/**/*.{ts,mts}'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },

  prettier,
)
