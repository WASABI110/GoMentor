import { useTranslation } from 'react-i18next'

/**
 * The winrate graph: the whole-record sweep's result, drawn as it fills.
 *
 * ## SVG, not canvas (the recorded decision)
 *
 * `design.md`'s trade-off table: ≤361 nodes at sweep tick rates (~1/s, one
 * per *completed* position) is far from the per-frame load that ruled SVG out
 * for the board itself. SVG buys clickable points, an a11y tree, and testable
 * geometry (`data-testid` per point) for free.
 *
 * ## The pending region is visibly not-data
 *
 * An unanalysed stretch must not read as a 50% flatline — an "even game" is a
 * *result*, and absence of analysis is not a result. The undrawn span is
 * therefore filled with a 45° hatch (`PATTERN_ID`, defined in `<defs>`) and
 * labelled, with the 50% midline drawn only under the analysed region, so
 * "we don't know yet" and "the engine says even" can never be confused
 * (`design.md` §Board overlays, and the Stage 4 brief).
 *
 * ## Reading the graph
 *
 * The curve is the sweep's settled winrate per position, side-to-move
 * perspective (the shared contract's convention), so a dip means the player
 * to move at that point had the floor fall out from under them. The area
 * between the curve and the midline is filled on both sides — black above,
 * white below — the conventional shape of a Go winrate graph.
 */

export interface WinrateGraphProps {
  /** Settled sweep points by move number (complete ticks only). */
  readonly sweep: Readonly<Record<number, { readonly winrate: number }>>
  /** Move count of the record; the x-axis runs 0..total. */
  readonly total: number
  /** Current cursor position; the marker tracks it. */
  readonly cursor: number
  /** Clicking an analysed point seeks the cursor there. */
  readonly onSeek: (moveNumber: number) => void
}

/** viewBox geometry: a 100×30 canvas, preserveAspectRatio="none" stretches it. */
const VIEW_WIDTH = 100
const VIEW_HEIGHT = 30
/** Margin reserved at the bottom for nothing — the curve uses the full box. */
const MIDLINE_Y = VIEW_HEIGHT / 2
/**
 * The pending region's hatch pattern. Referenced from CSS by this id, so the
 * two cannot drift; scoped to this component's figure, and stable across
 * renders (React re-creates the `<defs>` node, but the id — and every
 * reference to it — stays the same string).
 */
const PENDING_HATCH_PATTERN_ID = 'winrate-graph-pending-hatch'

function xFor(move: number, total: number): number {
  // Move 0 lands on the left edge, `total` on the right. A single-position
  // record (total 0) still gets a drawable point at x=0.
  return total <= 0 ? 0 : (move / total) * VIEW_WIDTH
}

function yFor(winrate: number): number {
  // Winrate 0..1 maps top..bottom; 50% sits on the midline.
  return (1 - winrate) * VIEW_HEIGHT
}

export function WinrateGraph({
  sweep,
  total,
  cursor,
  onSeek,
}: WinrateGraphProps): React.JSX.Element {
  const { t } = useTranslation(['analysis'])

  const analysed = Object.keys(sweep)
    .map(Number)
    .filter((move) => Number.isInteger(move) && move >= 0 && move <= total)
    .sort((a, b) => a - b)

  // The pending span starts at the first gap: the lowest unanalysed move at or
  // below the highest analysed one (an interior gap is pending too, not just
  // the tail), else the tail after the last analysed move.
  let pendingFrom: number | null = null
  if (analysed.length > 0) {
    const seen = new Set(analysed)
    for (let move = 0; move <= total; move += 1) {
      if (!seen.has(move)) {
        pendingFrom = move
        break
      }
    }
  } else {
    pendingFrom = 0
  }

  // The step curve: one horizontal run per analysed position at its winrate,
  // stepping down at the next analysed move. Drawn as a single path through
  // (x(move), y(winrate)) points with an initial drop to the first point.
  let curve = ''
  let area = ''
  if (analysed.length > 0) {
    const first = analysed[0]
    const firstY = first === undefined ? MIDLINE_Y : yFor(sweep[first]?.winrate ?? 0.5)
    const segments: string[] = [`M 0 ${String(firstY)}`]
    for (const move of analysed) {
      const x = xFor(move, total)
      const y = yFor(sweep[move]?.winrate ?? 0.5)
      segments.push(`L ${String(x)} ${String(y)}`)
      if (move < total) {
        segments.push(`L ${String(xFor(move + 1, total))} ${String(y)}`)
      }
    }
    curve = segments.join(' ')
    // Filled area between the curve and the midline: closed path down to the
    // midline at both ends.
    area = `${segments.join(' ')} L ${String(xFor(total, total))} ${String(MIDLINE_Y)} L 0 ${String(MIDLINE_Y)} Z`
  }

  const cursorX = xFor(cursor, total)

  function handleSeek(event: React.MouseEvent<SVGSVGElement>): void {
    const svg = event.currentTarget
    const rect = svg.getBoundingClientRect()
    if (rect.width === 0 || total <= 0) return
    const fraction = (event.clientX - rect.left) / rect.width
    onSeek(Math.round(fraction * total))
  }

  return (
    <figure className="winrate-graph" data-testid="winrate-graph">
      <svg
        viewBox={`0 0 ${String(VIEW_WIDTH)} ${String(VIEW_HEIGHT)}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={t('analysis:graph.label')}
        data-testid="winrate-graph-svg"
        onClick={handleSeek}
      >
        {/* The pending region's hatch: a 45° stripe tiled over the surface.
            CSS fills `.winrate-graph__pending` with this pattern by id. */}
        <defs>
          <pattern
            id={PENDING_HATCH_PATTERN_ID}
            width={3}
            height={3}
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width={3} height={3} className="winrate-graph__pending-base" />
            <line
              x1={0}
              y1={0}
              x2={0}
              y2={3}
              className="winrate-graph__pending-stripe"
            />
          </pattern>
        </defs>
        {/* Board: the pending region — hatched, explicitly not data. */}
        {pendingFrom !== null && pendingFrom <= total && (
          <rect
            className="winrate-graph__pending"
            data-testid="winrate-graph-pending"
            x={xFor(pendingFrom, total)}
            y={0}
            width={Math.max(0, VIEW_WIDTH - xFor(pendingFrom, total))}
            height={VIEW_HEIGHT}
          />
        )}
        {/* Midline under the analysed region only: a dashed 50% there is a
            real even-game reading; extending it across the pending region
            would smuggle "even" into "unknown". */}
        {analysed.length > 0 && pendingFrom !== null && (
          <line
            className="winrate-graph__midline"
            x1={0}
            y1={MIDLINE_Y}
            x2={xFor(pendingFrom, total)}
            y2={MIDLINE_Y}
          />
        )}
        {analysed.length > 0 && pendingFrom === null && (
          <line
            className="winrate-graph__midline"
            x1={0}
            y1={MIDLINE_Y}
            x2={VIEW_WIDTH}
            y2={MIDLINE_Y}
          />
        )}
        {/* Filled area under/over the curve. */}
        {area !== '' && <path className="winrate-graph__area" d={area} />}
        {/* The step curve itself. */}
        {curve !== '' && <path className="winrate-graph__curve" d={curve} />}
        {/* One clickable dot per analysed position. */}
        {analysed.map((move) => (
          <circle
            key={move}
            className="winrate-graph__point"
            data-testid={`winrate-point-${String(move)}`}
            data-move={move}
            cx={xFor(move, total)}
            cy={yFor(sweep[move]?.winrate ?? 0.5)}
            r={0.9}
            onClick={(event) => {
              event.stopPropagation()
              onSeek(move)
            }}
          />
        ))}
        {/* Cursor marker. */}
        <line
          className="winrate-graph__cursor"
          data-testid="winrate-cursor"
          x1={cursorX}
          y1={0}
          x2={cursorX}
          y2={VIEW_HEIGHT}
        />
      </svg>
      <figcaption className="winrate-graph__caption">
        {pendingFrom !== null
          ? t('analysis:graph.pending')
          : t('analysis:graph.complete')}
      </figcaption>
    </figure>
  )
}
