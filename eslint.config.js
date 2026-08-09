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
      // Destructuring-to-omit is how a field is dropped from an object without
      // mutating it — `const { [SECRETS_FIELD]: _secrets, ...rest } = document`
      // is the whole mechanism that keeps ciphertext out of the renderer's view.
      // The binding is deliberately unused, so the `_` prefix marks it as such.
      // `ignoreRestSiblings` (on by default) does not cover a *computed* key,
      // which is exactly the shape used above.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
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
    // Every IPC call must go through the typed wrappers in `main/ipc/`.
    //
    // This rule used to ban channel *string literals* anywhere in main, on the
    // stated grounds that "raw channel strings drift silently on rename". That
    // premise was measured and is false: `handle()` and `emit()` take
    // `C extends ChannelName` / `E extends EventName`, so a renamed or
    // mistyped channel is a TS2345 naming every valid channel — the loudest
    // possible failure. The rule fired on all 17 already-type-checked call
    // sites, and the remedy it advised ("import the channel from
    // @gomentor/shared/ipc") named an export that does not exist: shared
    // exports `CHANNELS` and `CHANNEL_NAMES`, never per-channel constants.
    //
    // What types *cannot* express is the invariant below: that nobody reaches
    // past the wrappers to Electron's primitives. A bare `ipcMain.handle` is
    // perfectly well-typed and silently skips request validation, response
    // validation, and error-envelope mapping — so a throw would cross the
    // boundary as a stringified Error and lose the `code` the renderer needs
    // (`error-handling.md`). That is the drift worth a linter.
    //
    // `register.ts` and `events.ts` are the two wrappers and are exempt.
    files: ['apps/desktop/src/**/*.{ts,tsx}'],
    ignores: [
      '**/*.test.ts',
      '**/*.spec.ts',
      'apps/desktop/src/main/ipc/register.ts',
      'apps/desktop/src/main/ipc/events.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.name='ipcMain'][property.name=/^(handle|handleOnce|on|once)$/]",
          message:
            'Register handlers with `handle()` from main/ipc/register, not ipcMain directly — it is what validates the request and maps throws to a typed envelope.',
        },
        {
          selector:
            "MemberExpression[property.name='send'][object.property.name='webContents']",
          message:
            'Push to the renderer with `emit()` from main/ipc/events, not webContents.send directly — it is what validates the payload and skips destroyed windows.',
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
