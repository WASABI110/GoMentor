import { Menu, app, shell, type MenuItemConstructorOptions } from 'electron'
import type { Locale } from '@gomentor/shared'
import { logsDir } from './paths'
import { scoped } from './logger'
import zhCN from '../renderer/src/i18n/locales/zh-CN/common.json'
import en from '../renderer/src/i18n/locales/en/common.json'

/**
 * Native application menu.
 *
 * ## "Reveal logs" ships in M1
 *
 * It is the single highest-value support affordance (`design.md` §Operational):
 * it turns "the app is broken" into a file a user can attach. Everything else in
 * this menu is table stakes; that item is the reason the file exists in M1 rather
 * than being deferred with the rest of the chrome.
 *
 * ## Main translates the menu itself, from the renderer's own JSON
 *
 * R10: "Main process shares the same JSON for native menu/dialogs." Not a copy —
 * the literal same files under `renderer/src/i18n/locales/`, imported here. A
 * missing key is then a TypeScript error at build time rather than a menu item
 * rendering as `undefined`.
 *
 * This replaced a `menu:setLabels` IPC channel that pushed already-translated
 * labels from the renderer. That design was written on the premise that "only the
 * renderer knows the locale", and the premise was false: `locale` lives in the
 * settings document, which main owns, and `index.ts` already reads
 * `settings.get()` before it builds the menu. Recorded because the channel was
 * fully built, tested, and documented before the premise was checked — see
 * `prd.md` R4.
 *
 * Keeping translation here also closes a gap the channel could not: the menu is
 * correct from the first paint, whereas labels arriving over IPC leave the bar in
 * English until the renderer has mounted and initialised i18n.
 */
const logger = scoped('main:menu')

/**
 * The menu's slice of the `common` namespace, per locale.
 *
 * Typed as `Record<Locale, ...>` deliberately: `localeSchema` lists six locales
 * and only two have catalogues in M1 (R10 defers ja/ko/th/vi to M5), so this
 * would not compile as a total record. `Partial` plus an explicit fallback makes
 * the gap visible instead of letting a missing locale become a runtime
 * `undefined` deref — a user whose settings say `ja` gets English, not a crash.
 */
const CATALOGUES: Partial<Record<Locale, MenuLabels>> = {
  'zh-CN': zhCN.menu,
  en: en.menu,
}

/**
 * The twelve strings this menu needs, derived from the authoring locale's JSON
 * rather than declared.
 *
 * `typeof zhCN.menu` and not a hand-written interface: a hand-written one is a
 * second description of the same keys, and the two can disagree. This way adding
 * a key to the JSON without using it is harmless, while *using* a key that no
 * catalogue has is a compile error.
 */
type MenuLabels = typeof zhCN.menu

/**
 * English, not zh-CN, when a locale has no catalogue. An untranslated menu is a
 * visible gap that gets reported; a menu silently hardcoded to the authoring
 * locale looks intentional and never gets fixed.
 */
function labelsFor(locale: Locale): MenuLabels {
  return CATALOGUES[locale] ?? en.menu
}

export interface MenuActions {
  /** Triggers the renderer's open flow, so the picker and the import share a path. */
  openSgf(): void
}

export function buildMenu(actions: MenuActions, locale: Locale): Menu {
  const labels = labelsFor(locale)
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    // macOS convention: the first submenu is the app menu and carries Quit.
    // Omitting it on macOS does not move Quit elsewhere, it removes it.
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const, label: labels.quit },
            ],
          },
        ]
      : []),

    {
      label: labels.file,
      submenu: [
        {
          label: labels.openSgf,
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            actions.openSgf()
          },
        },
        { type: 'separator' },
        // Quit lives in the app menu on macOS, so this is the non-mac path only.
        ...(isMac ? [] : [{ role: 'quit' as const, label: labels.quit }]),
      ],
    },

    {
      label: labels.view,
      submenu: [
        { role: 'reload', label: labels.reload },
        // Kept in production builds on purpose: it is how a user produces the
        // console output a bug report needs, and hiding it behind a rebuild
        // makes remote diagnosis impossible.
        { role: 'toggleDevTools', label: labels.toggleDevTools },
        { type: 'separator' },
        { role: 'resetZoom', label: labels.resetZoom },
        { role: 'zoomIn', label: labels.zoomIn },
        { role: 'zoomOut', label: labels.zoomOut },
        { type: 'separator' },
        { role: 'togglefullscreen', label: labels.fullScreen },
      ],
    },

    {
      label: labels.help,
      submenu: [
        {
          label: labels.revealLogs,
          click: () => {
            const directory = logsDir()
            // `openPath` on the directory rather than `showItemInFolder` on the
            // log file: the file does not exist until something is logged, and
            // `showItemInFolder` on a missing path silently does nothing —
            // which reads to the user as a dead menu item.
            void shell.openPath(directory).then((error) => {
              if (error !== '') logger.warn('could not open logs directory', { error })
            })
          },
        },
      ],
    },
  ]

  return Menu.buildFromTemplate(template)
}

/**
 * Builds and installs the menu for a locale.
 *
 * Call it again after a locale change: Electron replaces the whole menu, so
 * there is no partial-update path to get wrong. `index.ts` calls this on startup
 * and the settings handler calls it when `locale` changes.
 */
export function applyMenu(actions: MenuActions, locale: Locale): void {
  Menu.setApplicationMenu(buildMenu(actions, locale))
}
