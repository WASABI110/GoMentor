import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { scoped } from './logger'
import type { SettingsService } from './settings'

/**
 * Window creation and bounds persistence.
 *
 * ## `webPreferences` is a security boundary
 *
 * `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. A leak
 * here is a sandbox escape, not a bug (`implement.md` §Risky files) — the
 * renderer loads content influenced by model output and by files the user
 * imported, so Node reachability from the page is a remote-code-execution path.
 * Stage 5 asserts the absence of `window.require` and `window.ipcRenderer` at
 * runtime in the renderer, because reading this file is not evidence the flags
 * took effect.
 *
 * ## Why bounds are validated against displays
 *
 * A window restored to its saved position lands off-screen when the monitor it
 * was on is gone — a docked laptop is the everyday case. The window then exists,
 * has focus, and is invisible, which presents to the user as "the app won't
 * open" with no way to recover short of clearing settings.
 */

const logger = scoped('main:window')

const DEFAULTS = { width: 1440, height: 900, minWidth: 1024, minHeight: 700 } as const

/**
 * Stored under a key the settings schema does not name, preserved by its
 * `.loose()`. Window geometry is not user-facing configuration — it should not
 * appear in a settings UI — but it does belong in the same document so there is
 * one file to back up and one to delete when recovering.
 */
const BOUNDS_KEY = 'windowBounds'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

function isBounds(value: unknown): value is Bounds {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate['x'] === 'number' &&
    typeof candidate['y'] === 'number' &&
    typeof candidate['width'] === 'number' &&
    typeof candidate['height'] === 'number'
  )
}

/**
 * Whether a saved rectangle is still usable.
 *
 * Requires overlap with a display rather than full containment: a window the
 * user deliberately left hanging off the right edge is fine, and demanding
 * containment would reposition it on every launch. The threshold is that enough
 * of the title bar is reachable to drag it back.
 */
function isOnScreen(bounds: Bounds): boolean {
  const MIN_VISIBLE = 80
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea
    const overlapX =
      Math.min(bounds.x + bounds.width, area.x + area.width) -
      Math.max(bounds.x, area.x)
    const overlapY =
      Math.min(bounds.y + bounds.height, area.y + area.height) -
      Math.max(bounds.y, area.y)
    return overlapX >= MIN_VISIBLE && overlapY >= MIN_VISIBLE
  })
}

export function createWindow(settings: SettingsService): BrowserWindow {
  const saved = (settings.get() as unknown as Record<string, unknown>)[BOUNDS_KEY]
  const restorable = isBounds(saved) && isOnScreen(saved) ? saved : undefined

  if (isBounds(saved) && restorable === undefined) {
    // Worth a line: this is the diagnostic for "my window moved" after a
    // monitor change, and without it the repositioning looks arbitrary.
    logger.warn('saved window bounds are off-screen, using defaults', {
      width: saved.width,
      height: saved.height,
    })
  }

  const window = new BrowserWindow({
    ...DEFAULTS,
    ...(restorable ?? {}),
    show: false,
    webPreferences: {
      // electron-vite emits the preload as CJS `.js` here (it only switches to
      // `.mjs` when package.json declares "type": "module"). CJS is required
      // anyway: a sandboxed preload cannot be an ES module.
      preload: join(__dirname, '../preload/index.js'),
      // Security boundary. See the module note.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  // Shown on `ready-to-show` rather than immediately, so the first paint is the
  // app rather than a white rectangle.
  window.on('ready-to-show', () => {
    window.show()
  })

  // Debounced: `resize` fires per frame during a drag, and persisting each one
  // would mean a settings write per frame.
  let pending: NodeJS.Timeout | undefined
  const persistBounds = (): void => {
    if (pending !== undefined) clearTimeout(pending)
    pending = setTimeout(() => {
      pending = undefined
      // Maximised or minimised geometry is not what should be restored — the
      // user wants the window maximised again, not a window the size of the
      // screen minus the taskbar. `getNormalBounds` is the pre-maximise
      // rectangle.
      if (window.isDestroyed()) return
      const bounds = window.getNormalBounds()
      try {
        settings.update({ [BOUNDS_KEY]: bounds })
      } catch (error) {
        // A failed geometry write must not take down the window. It is the least
        // important thing in the document.
        logger.failure('could not persist window bounds', error)
      }
    }, 400)
  }

  window.on('resize', persistBounds)
  window.on('move', persistBounds)
  window.on('close', () => {
    if (pending !== undefined) clearTimeout(pending)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}
