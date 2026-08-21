import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMainProcessEvents } from './hooks/useMainProcessEvents'
import { useSettingsStore } from './state/settingsStore'
import { LibraryPanel } from './panels/LibraryPanel'
import { BoardPanel } from './panels/BoardPanel'
import { TeacherPanel } from './panels/TeacherPanel'

/**
 * The three-panel shell.
 *
 * ## The event subscriptions live here, not in the panels
 *
 * `useMainProcessEvents` is called once, at the only component guaranteed to be
 * mounted for the app's whole life. A subscription inside a panel would end when
 * that panel unmounted, and the store would then miss an import or drop tokens
 * mid-answer — see the hook's own comment for why each event is app-scoped rather
 * than panel-scoped.
 *
 * ## Widths come from settings, and the drag handle writes them back
 *
 * `ui.panelWidths` is persisted and read here. Two resize handles between the
 * panels update the widths on drag and persist them on release through
 * `settingsStore.update`. Applying the stored widths first means there is one
 * source of truth; local state during a drag is temporary and is reconciled with
 * the persisted value only when the user finishes dragging.
 *
 * Before `load()` resolves, `settings` is `null` and the CSS defaults in
 * `global.css` apply — deliberately, per `settingsStore`'s note on why there is no
 * defaults-shaped placeholder.
 */

const MIN_LIBRARY_WIDTH = 180
const MIN_TEACHER_WIDTH = 240
const HANDLE_WIDTH = 8

export function App(): React.JSX.Element {
  const { t } = useTranslation('common')
  useMainProcessEvents()

  const settings = useSettingsStore((state) => state.settings)
  const updateSettings = useSettingsStore((state) => state.update)
  const widths = settings?.ui.panelWidths

  // Local widths during a drag, so the grid updates every frame without waiting
  // for an IPC round trip.
  const [liveWidths, setLiveWidths] = useState<{
    library: number
    teacher: number
  } | null>(null)

  const [isDragging, setIsDragging] = useState(false)

  const shellRef = useRef<HTMLDivElement>(null)
  const dragging = useRef<
    | {
        side: 'library' | 'teacher'
        startX: number
        startWidth: number
        shellWidth: number
      }
    | undefined
  >(undefined)

  const effectiveWidths = liveWidths ?? widths

  const stopDragging = useCallback((): void => {
    if (dragging.current === undefined) return

    const { side } = dragging.current
    if (liveWidths !== null) {
      void updateSettings({
        ui: {
          panelWidths: {
            [side]: side === 'library' ? liveWidths.library : liveWidths.teacher,
          },
        },
      })
    }

    dragging.current = undefined
    setLiveWidths(null)
    setIsDragging(false)
  }, [liveWidths, updateSettings])

  useEffect(() => {
    if (!isDragging) return

    function onMouseMove(event: MouseEvent): void {
      if (dragging.current === undefined || effectiveWidths === undefined) return

      const { side, startX, startWidth, shellWidth } = dragging.current
      const delta = event.clientX - startX

      if (side === 'library') {
        const next = Math.max(
          MIN_LIBRARY_WIDTH,
          Math.min(startWidth + delta, shellWidth / 2),
        )
        setLiveWidths({ library: next, teacher: effectiveWidths.teacher })
      } else {
        const next = Math.max(
          MIN_TEACHER_WIDTH,
          Math.min(startWidth - delta, shellWidth / 2),
        )
        setLiveWidths({ library: effectiveWidths.library, teacher: next })
      }
    }

    function onMouseUp(): void {
      stopDragging()
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)

    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [isDragging, effectiveWidths, stopDragging])

  function startLibraryResize(event: React.MouseEvent<HTMLDivElement>): void {
    if (shellRef.current === null || widths === undefined) return
    dragging.current = {
      side: 'library',
      startX: event.clientX,
      startWidth: widths.library,
      shellWidth: shellRef.current.clientWidth,
    }
    setIsDragging(true)
  }

  function startTeacherResize(event: React.MouseEvent<HTMLDivElement>): void {
    if (shellRef.current === null || widths === undefined) return
    dragging.current = {
      side: 'teacher',
      startX: event.clientX,
      startWidth: widths.teacher,
      shellWidth: shellRef.current.clientWidth,
    }
    setIsDragging(true)
  }

  return (
    <div
      ref={shellRef}
      className="app-shell"
      data-testid="app-shell"
      style={
        effectiveWidths === undefined
          ? undefined
          : {
              gridTemplateColumns: `${String(effectiveWidths.library)}px ${String(HANDLE_WIDTH)}px 1fr ${String(HANDLE_WIDTH)}px ${String(effectiveWidths.teacher)}px`,
            }
      }
    >
      {/*
        The accessible name of the whole app, for screen readers and for the e2e
        specs' `getByRole` queries. Not a visible heading: the window title bar
        already carries the app name, and repeating it would spend a row of a
        three-panel layout on something the user can already see.
      */}
      <h1 className="sr-only">{t('appName')}</h1>

      <LibraryPanel />
      <div
        className="resize-handle"
        data-testid="resize-handle-library"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('resize.library')}
        onMouseDown={startLibraryResize}
      />
      <BoardPanel />
      <div
        className="resize-handle"
        data-testid="resize-handle-teacher"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('resize.teacher')}
        onMouseDown={startTeacherResize}
      />
      <TeacherPanel />
    </div>
  )
}
