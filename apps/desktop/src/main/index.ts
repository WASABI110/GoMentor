import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'

// Stage 1 skeleton: single-instance lock, lifecycle, window creation.
// Stage 4 adds paths, logger, settings, safe-storage, and IPC registration.

// Two instances would fight over settings, the log file, and — from M2 —
// SQLite and the GPU.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    webPreferences: {
      // electron-vite emits the preload as CJS `.js` here (it only switches to
      // `.mjs` when package.json declares "type": "module"). CJS is required
      // anyway: a sandboxed preload cannot be an ES module.
      preload: join(__dirname, '../preload/index.js'),
      // Security boundary. A leak here is a sandbox escape, not a bug.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

void app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => {
  const [existing] = BrowserWindow.getAllWindows()
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
