import { Menu, app, shell, type MenuItemConstructorOptions } from 'electron'
import { logsDir } from './paths'
import { scoped } from './logger'

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
 * ## Labels are passed in, not translated here
 *
 * The native menu is built in main, but the i18n resources live in the renderer
 * (R10). Rather than duplicate the catalogue into main — where it would drift —
 * the caller supplies already-translated strings. Stage 6 wires the renderer's
 * locale change to a rebuild; until then the defaults below are the fallback,
 * which is why they are English: an untranslated menu is a visible gap, whereas a
 * menu hardcoded to zh-CN would look intentional and never get fixed.
 */

const logger = scoped('main:menu')

export interface MenuLabels {
  file: string
  openSgf: string
  quit: string
  view: string
  reload: string
  toggleDevTools: string
  resetZoom: string
  zoomIn: string
  zoomOut: string
  fullScreen: string
  help: string
  revealLogs: string
}

export const DEFAULT_LABELS: MenuLabels = {
  file: 'File',
  openSgf: 'Open SGF…',
  quit: 'Quit',
  view: 'View',
  reload: 'Reload',
  toggleDevTools: 'Toggle Developer Tools',
  resetZoom: 'Reset Zoom',
  zoomIn: 'Zoom In',
  zoomOut: 'Zoom Out',
  fullScreen: 'Toggle Full Screen',
  help: 'Help',
  revealLogs: 'Reveal Logs',
}

export interface MenuActions {
  /** Triggers the renderer's open flow, so the picker and the import share a path. */
  openSgf(): void
}

export function buildMenu(
  actions: MenuActions,
  labels: MenuLabels = DEFAULT_LABELS,
): Menu {
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

export function applyMenu(actions: MenuActions, labels?: MenuLabels): void {
  Menu.setApplicationMenu(buildMenu(actions, labels))
}
