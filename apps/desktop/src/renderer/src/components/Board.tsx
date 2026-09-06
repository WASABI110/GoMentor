import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BoardSize, Coord, Player } from '@gomentor/shared'
import { Position } from '@gomentor/core/board/position'
import {
  computeGeometry,
  fromPixel,
  toPixel,
  type BoardGeometry,
} from '@gomentor/core/board/coords'

/**
 * A Go board rendered on two canvases.
 *
 * ## Two layers
 *
 * - **Static layer** (`staticCanvas`): the grid, star points, coordinate labels,
 *   and the wooden board background. This changes only when the board size or the
 *   pixel dimensions change, so it is rendered once and cached.
 * - **Dynamic layer** (`dynamicCanvas`): stones, last-move marker, hover ghost,
 *   capture animations, and the analysis overlays (ownership fill, candidate
 *   letters, PV ghost stones). This changes on every cursor step, so it redraws
 *   frequently.
 *
 * Splitting them avoids re-drawing the grid lines for every cursor step. The
 * static layer is repainted only on resize or board-size change.
 *
 * ## DPR awareness
 *
 * `width`/`height` are CSS pixels; the canvas backing store is scaled by
 * `window.devicePixelRatio`. Mouse coordinates come in CSS pixels from DOM events
 * and are converted to board coordinates via `fromPixel` from `@gomentor/core`,
 * which works in CSS pixels because `computeGeometry` returns CSS pixels.
 *
 * ## Animations are capped and cancellable
 *
 * Capture animations are rendered on the dynamic layer for up to 120ms. A new
 * animation frame calls `cancelAnimationFrame` on the previous one, and a new
 * capture event resets the start time — so stepping quickly through a game does
 * not queue animations or show stale captures.
 *
 * ## The analysis overlays are inputs, not state
 *
 * Board is presentational: it renders the candidate markers, PV ghosts, and
 * ownership array it is handed and holds none of that as its own state. What is
 * worth knowing is the draw order — ownership fill under the stones (a point a
 * player owns reads through the stone on it), then captures, the last-move
 * marker, candidate letters, PV ghosts, and the hover ghost on top. A wrong
 * order is a real bug class: candidates drawn under stones would vanish on
 * occupied points, which is where most candidates are late in a game.
 */

/** A suggested-move marker: the letter, its point, and how strongly to paint it. */
export interface CandidateMarker {
  coord: Coord
  /** The label, 'A'..'E' by candidate rank. */
  label: string
  /** 0..1 disc alpha, derived from the candidate's winrate. */
  alpha: number
}

/** One ghost stone of a hovered candidate's principal variation. */
export interface PvGhost {
  coord: Coord
  /** 1-based position along the variation, rendered inside the stone. */
  index: number
  player: Player
}

interface BoardProps {
  /** Board size; determines grid count. */
  size: BoardSize
  /** The position to render. */
  position: Position
  /** The last move played, for the marker. `null` after a pass. */
  lastMove?: { coord: Coord; player: Player } | null
  /** Stones removed by the last move, for the capture flash. */
  captured?: Coord[]
  /** Optional ghost stone under the cursor. */
  hover?: Coord | null
  /** Suggested-move markers for the analysed position (letters A–E). */
  candidates?: readonly CandidateMarker[]
  /** Ghost stones of the hovered candidate's principal variation. */
  pv?: readonly PvGhost[]
  /** Per-point ownership (-1..1, row-major, length size²); null hides it. */
  ownership?: readonly number[] | null
  /** Called when the user clicks a valid intersection. */
  onClick?: (coord: Coord) => void
  /** Called when the user hovers over an intersection. */
  onHover?: (coord: Coord | null) => void
  /** Whether to show coordinate labels around the edge. */
  showCoordinates?: boolean
  /** Whether to animate captures. */
  animationsEnabled?: boolean
}

/** Board theme colours. Kept local because they are pure presentation. */
const THEME = {
  board: '#e4b464',
  boardDark: '#d4a050',
  line: '#5c4033',
  star: '#4a3528',
  lastMove: '#ff4d4d',
  black: '#1a1a1a',
  white: '#f2f0e8',
  ghostBlack: 'rgba(26, 26, 26, 0.45)',
  ghostWhite: 'rgba(242, 240, 232, 0.55)',
  // Candidate markers and ownership tints. Channels only — the alpha rides per
  // marker/point, so a hex string would need parsing at draw time.
  candidate: '43, 108, 176',
  candidateText: '#ffffff',
  blackChannels: '26, 26, 26',
  whiteChannels: '242, 240, 232',
}

/** Points with |ownership| below this stay un-tinted — near-neutral is noise. */
const OWNERSHIP_THRESHOLD = 0.15

/** The 9×9, 13×13 and 19×19 star-point coordinates, zero-indexed. */
const STAR_POINTS: Record<BoardSize, Coord[]> = {
  9: [
    { x: 2, y: 2 },
    { x: 6, y: 2 },
    { x: 4, y: 4 },
    { x: 2, y: 6 },
    { x: 6, y: 6 },
  ],
  13: [
    { x: 3, y: 3 },
    { x: 9, y: 3 },
    { x: 6, y: 6 },
    { x: 3, y: 9 },
    { x: 9, y: 9 },
  ],
  19: [
    { x: 3, y: 3 },
    { x: 9, y: 3 },
    { x: 15, y: 3 },
    { x: 3, y: 9 },
    { x: 9, y: 9 },
    { x: 15, y: 9 },
    { x: 3, y: 15 },
    { x: 9, y: 15 },
    { x: 15, y: 15 },
  ],
}

/** The SGF/GTP column letters, used for coordinate labels. */
const COLUMN_LETTERS = 'ABCDEFGHJKLMNOPQRST' as const

/** Maximum duration of a capture flash, in milliseconds. */
const MAX_CAPTURE_ANIMATION_MS = 120

export function Board({
  size,
  position,
  lastMove = null,
  captured = [],
  hover = null,
  candidates = [],
  pv = [],
  ownership = null,
  onClick,
  onHover,
  showCoordinates = true,
  animationsEnabled = true,
}: BoardProps): React.JSX.Element {
  const { t } = useTranslation('board')
  const containerRef = useRef<HTMLDivElement>(null)
  const staticCanvasRef = useRef<HTMLCanvasElement>(null)
  const dynamicCanvasRef = useRef<HTMLCanvasElement>(null)

  // CSS-pixel dimensions, measured from the container.
  const [cssSize, setCssSize] = useState<number>(0)

  // Track the most recent capture set and animation start time so the dynamic
  // layer can fade captures out over MAX_CAPTURE_ANIMATION_MS.
  const captureRef = useRef<{ coords: Coord[]; start: number } | null>(null)
  const rafRef = useRef<number | null>(null)

  // Measure the container on mount and on resize.
  useEffect(() => {
    const element = containerRef.current
    if (element === null) return undefined

    const measure = (): void => {
      const rect = element.getBoundingClientRect()
      const next = Math.min(rect.width, rect.height)
      setCssSize((current) => (next > 0 && next !== current ? next : current))
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    window.addEventListener('resize', measure)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  // Kick off a capture animation when the captured prop changes.
  useEffect(() => {
    if (captured.length === 0) {
      captureRef.current = null
      return
    }
    captureRef.current = { coords: captured, start: performance.now() }
  }, [captured])

  const geometry = cssSize > 0 ? computeGeometry(cssSize, size) : null
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1

  // Redraw the static layer whenever size or dimensions change.
  useEffect(() => {
    const canvas = staticCanvasRef.current
    if (canvas === null || geometry === null || cssSize <= 0) return

    setupCanvas(canvas, cssSize, dpr)
    const ctx = canvas.getContext('2d')
    if (ctx === null) return

    drawStatic(ctx, size, geometry, showCoordinates)
  }, [cssSize, dpr, geometry, size, showCoordinates])

  // Redraw the dynamic layer whenever the position, last move, hover, analysis
  // overlays, or capture animation state changes.
  useEffect(() => {
    const canvas = dynamicCanvasRef.current
    if (canvas === null || geometry === null || cssSize <= 0) return

    setupCanvas(canvas, cssSize, dpr)
    const ctx = canvas.getContext('2d')
    if (ctx === null) return

    const draw = (now: number): void => {
      const capture = captureRef.current
      const captureProgress =
        capture === null || !animationsEnabled
          ? null
          : Math.min(1, (now - capture.start) / MAX_CAPTURE_ANIMATION_MS)

      drawDynamic(
        ctx,
        size,
        geometry,
        position,
        lastMove,
        hover,
        capture,
        captureProgress,
        candidates,
        pv,
        ownership,
      )

      // Continue animating only while a capture flash is active.
      if (capture !== null && captureProgress !== null && captureProgress < 1) {
        rafRef.current = requestAnimationFrame(draw)
      } else {
        rafRef.current = null
      }
    }

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
    }
    rafRef.current = requestAnimationFrame(draw)

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [
    cssSize,
    dpr,
    geometry,
    size,
    position,
    lastMove,
    hover,
    candidates,
    pv,
    ownership,
    animationsEnabled,
  ])

  function handleMouseMove(event: React.MouseEvent<HTMLCanvasElement>): void {
    if (onHover === undefined || geometry === null) return
    const coord = eventCoord(event, geometry, size)
    onHover(coord)
  }

  function handleMouseLeave(): void {
    if (onHover !== undefined) onHover(null)
  }

  function handleClick(event: React.MouseEvent<HTMLCanvasElement>): void {
    if (onClick === undefined || geometry === null) return
    const coord = eventCoord(event, geometry, size)
    if (coord !== null) onClick(coord)
  }

  return (
    <div
      ref={containerRef}
      className="board"
      data-testid="board-canvas"
      aria-label={t('title')}
      style={{ width: '100%', height: '100%', position: 'relative' }}
    >
      <canvas
        ref={staticCanvasRef}
        className="board__static"
        style={{ position: 'absolute', inset: 0, width: cssSize, height: cssSize }}
      />
      <canvas
        ref={dynamicCanvasRef}
        className="board__dynamic"
        style={{ position: 'absolute', inset: 0, width: cssSize, height: cssSize }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
      />
    </div>
  )
}

/** Convert a mouse event to a board coordinate, or null if off the grid. */
function eventCoord(
  event: React.MouseEvent<HTMLCanvasElement>,
  geometry: BoardGeometry,
  size: BoardSize,
): Coord | null {
  const rect = event.currentTarget.getBoundingClientRect()
  const px = event.clientX - rect.left
  const py = event.clientY - rect.top
  return fromPixel(px, py, size, geometry)
}

/** Set the canvas backing store to DPR-scaled CSS dimensions. */
function setupCanvas(canvas: HTMLCanvasElement, cssSize: number, dpr: number): void {
  const scaled = Math.floor(cssSize * dpr)
  if (canvas.width !== scaled || canvas.height !== scaled) {
    canvas.width = scaled
    canvas.height = scaled
  }
  const ctx = canvas.getContext('2d')
  if (ctx !== null) {
    ctx.resetTransform()
    ctx.scale(dpr, dpr)
  }
}

function drawStatic(
  ctx: CanvasRenderingContext2D,
  size: BoardSize,
  geometry: BoardGeometry,
  showCoordinates: boolean,
): void {
  ctx.clearRect(
    0,
    0,
    geometry.padding * 2 + geometry.spacing * (size - 1),
    geometry.padding * 2 + geometry.spacing * (size - 1),
  )

  drawBoardBackground(ctx, size, geometry)
  drawGrid(ctx, size, geometry)
  drawStarPoints(ctx, size, geometry)
  if (showCoordinates) drawCoordinates(ctx, size, geometry)
}

function drawBoardBackground(
  ctx: CanvasRenderingContext2D,
  size: BoardSize,
  geometry: BoardGeometry,
): void {
  const total = geometry.padding * 2 + geometry.spacing * (size - 1)
  const gradient = ctx.createLinearGradient(0, 0, total, total)
  gradient.addColorStop(0, THEME.board)
  gradient.addColorStop(1, THEME.boardDark)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, total, total)
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  size: BoardSize,
  geometry: BoardGeometry,
): void {
  ctx.strokeStyle = THEME.line
  ctx.lineWidth = Math.max(1, geometry.spacing / 40)
  ctx.beginPath()
  for (let index = 0; index < size; index += 1) {
    const offset = geometry.padding + index * geometry.spacing
    ctx.moveTo(geometry.padding, offset)
    ctx.lineTo(geometry.padding + (size - 1) * geometry.spacing, offset)
    ctx.moveTo(offset, geometry.padding)
    ctx.lineTo(offset, geometry.padding + (size - 1) * geometry.spacing)
  }
  ctx.stroke()
}

function drawStarPoints(
  ctx: CanvasRenderingContext2D,
  size: BoardSize,
  geometry: BoardGeometry,
): void {
  ctx.fillStyle = THEME.star
  const radius = Math.max(2, geometry.spacing / 12)
  for (const star of STAR_POINTS[size]) {
    const { px, py } = toPixel(star, size, geometry)
    ctx.beginPath()
    ctx.arc(px, py, radius, 0, Math.PI * 2)
    ctx.fill()
  }
}

function drawCoordinates(
  ctx: CanvasRenderingContext2D,
  size: BoardSize,
  geometry: BoardGeometry,
): void {
  ctx.fillStyle = THEME.line
  ctx.font = `${String(Math.max(10, geometry.spacing / 2.5))}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  for (let index = 0; index < size; index += 1) {
    const letter = COLUMN_LETTERS[index]
    if (letter === undefined) continue
    const offset = geometry.padding + index * geometry.spacing

    // Top edge.
    ctx.fillText(letter, offset, geometry.padding / 2)
    // Bottom edge.
    ctx.fillText(
      letter,
      offset,
      geometry.padding + (size - 1) * geometry.spacing + geometry.padding / 2,
    )
    // Row numbers count from the bottom, like GTP.
    const row = String(size - index)
    // Left edge.
    ctx.fillText(row, geometry.padding / 2, offset)
    // Right edge.
    ctx.fillText(
      row,
      geometry.padding + (size - 1) * geometry.spacing + geometry.padding / 2,
      offset,
    )
  }
}

function drawDynamic(
  ctx: CanvasRenderingContext2D,
  size: BoardSize,
  geometry: BoardGeometry,
  position: Position,
  lastMove: { coord: Coord; player: Player } | null,
  hover: Coord | null,
  capture: { coords: Coord[]; start: number } | null,
  captureProgress: number | null,
  candidates: readonly CandidateMarker[],
  pv: readonly PvGhost[],
  ownership: readonly number[] | null,
): void {
  const total = geometry.padding * 2 + geometry.spacing * (size - 1)
  ctx.clearRect(0, 0, total, total)

  // Ownership first: it tints the board itself and must sit under the stones.
  if (ownership !== null) drawOwnership(ctx, ownership, size, geometry)

  const stones = position.toArray()
  for (let index = 0; index < stones.length; index += 1) {
    const player = stones[index]
    if (player === null || player === undefined) continue
    const coord = { x: index % size, y: Math.floor(index / size) }
    drawStone(ctx, coord, player, size, geometry)
  }

  // Capture flash: draw a fading ring where stones were removed.
  if (capture !== null && captureProgress !== null) {
    const alpha = 1 - captureProgress
    ctx.strokeStyle = `rgba(255, 77, 77, ${String(alpha)})`
    ctx.lineWidth = Math.max(2, geometry.spacing / 16)
    for (const coord of capture.coords) {
      const { px, py } = toPixel(coord, size, geometry)
      ctx.beginPath()
      ctx.arc(
        px,
        py,
        geometry.spacing * 0.4 * (1 + captureProgress * 0.3),
        0,
        Math.PI * 2,
      )
      ctx.stroke()
    }
  }

  if (lastMove !== null) {
    drawLastMoveMarker(ctx, lastMove.coord, lastMove.player, size, geometry)
  }

  for (const marker of candidates) {
    drawCandidateMarker(ctx, marker, size, geometry)
  }

  for (const ghost of pv) {
    drawPvGhost(ctx, ghost, size, geometry)
  }

  if (hover !== null && position.isEmpty(hover)) {
    const player: Player = lastMove?.player === 'black' ? 'white' : 'black'
    drawGhostStone(ctx, hover, player, size, geometry)
  }
}

/**
 * Per-point ownership as a tinted disc under each stone. Positive favours
 * black, negative white; the magnitude drives the alpha so a contested point
 * stays pale and a settled one reads clearly.
 *
 * The length guard is defence in depth, not the primary check: main's parser
 * rejects a wrong-length array before it can be emitted, so a bad length here
 * would mean the contract broke between processes — and painting it would
 * shift every value after the gap onto the wrong point.
 */
function drawOwnership(
  ctx: CanvasRenderingContext2D,
  ownership: readonly number[],
  size: BoardSize,
  geometry: BoardGeometry,
): void {
  if (ownership.length !== size * size) return
  const radius = geometry.spacing * 0.48
  for (let index = 0; index < ownership.length; index += 1) {
    const value = ownership[index]
    if (value === undefined || Math.abs(value) < OWNERSHIP_THRESHOLD) continue
    const coord = { x: index % size, y: Math.floor(index / size) }
    const { px, py } = toPixel(coord, size, geometry)
    const strength = Math.min(1, Math.abs(value))
    ctx.beginPath()
    ctx.arc(px, py, radius, 0, Math.PI * 2)
    ctx.fillStyle =
      value > 0
        ? `rgba(${THEME.blackChannels}, ${(strength * 0.4).toFixed(3)})`
        : `rgba(${THEME.whiteChannels}, ${(strength * 0.5).toFixed(3)})`
    ctx.fill()
  }
}

/** A lettered suggested-move disc; the alpha was derived from its winrate. */
function drawCandidateMarker(
  ctx: CanvasRenderingContext2D,
  marker: CandidateMarker,
  size: BoardSize,
  geometry: BoardGeometry,
): void {
  const { px, py } = toPixel(marker.coord, size, geometry)
  const radius = geometry.spacing * 0.32

  ctx.beginPath()
  ctx.arc(px, py, radius, 0, Math.PI * 2)
  ctx.fillStyle = `rgba(${THEME.candidate}, ${marker.alpha.toFixed(3)})`
  ctx.fill()

  ctx.fillStyle = THEME.candidateText
  ctx.font = `bold ${String(Math.max(8, geometry.spacing * 0.34))}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(marker.label, px, py)
}

/** One numbered ghost stone of a principal variation. */
function drawPvGhost(
  ctx: CanvasRenderingContext2D,
  ghost: PvGhost,
  size: BoardSize,
  geometry: BoardGeometry,
): void {
  drawGhostStone(ctx, ghost.coord, ghost.player, size, geometry)
  const { px, py } = toPixel(ghost.coord, size, geometry)
  ctx.fillStyle =
    ghost.player === 'black' ? 'rgba(242,240,232,0.9)' : 'rgba(26,26,26,0.75)'
  ctx.font = `bold ${String(Math.max(7, geometry.spacing * 0.3))}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(ghost.index), px, py)
}

function drawStone(
  ctx: CanvasRenderingContext2D,
  coord: Coord,
  player: Player,
  size: BoardSize,
  geometry: BoardGeometry,
): void {
  const { px, py } = toPixel(coord, size, geometry)
  const radius = geometry.spacing * 0.46

  ctx.beginPath()
  ctx.arc(px, py, radius, 0, Math.PI * 2)
  ctx.fillStyle = player === 'black' ? THEME.black : THEME.white
  ctx.fill()

  // Subtle highlight so stones read as spheres rather than flat discs.
  ctx.strokeStyle = player === 'black' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.15)'
  ctx.lineWidth = Math.max(1, geometry.spacing / 35)
  ctx.stroke()
}

function drawGhostStone(
  ctx: CanvasRenderingContext2D,
  coord: Coord,
  player: Player,
  size: BoardSize,
  geometry: BoardGeometry,
): void {
  const { px, py } = toPixel(coord, size, geometry)
  const radius = geometry.spacing * 0.46

  ctx.beginPath()
  ctx.arc(px, py, radius, 0, Math.PI * 2)
  ctx.fillStyle = player === 'black' ? THEME.ghostBlack : THEME.ghostWhite
  ctx.fill()
}

function drawLastMoveMarker(
  ctx: CanvasRenderingContext2D,
  coord: Coord,
  player: Player,
  size: BoardSize,
  geometry: BoardGeometry,
): void {
  const { px, py } = toPixel(coord, size, geometry)
  const radius = geometry.spacing * 0.15

  ctx.beginPath()
  ctx.arc(px, py, radius, 0, Math.PI * 2)
  ctx.fillStyle = player === 'black' ? THEME.lastMove : THEME.lastMove
  ctx.fill()
}
