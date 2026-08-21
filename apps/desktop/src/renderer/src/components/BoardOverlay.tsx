/**
 * Board overlay layer scaffold.
 *
 * M1 renders the position on the dynamic canvas and needs no SVG/DOM overlay.
 * M2 will fill this layer with ownership heatmaps, candidate-move markers, and
 * territory estimates that are easier to paint as DOM/SVG than as canvas
 * pixels. Landing the empty component now keeps the board's layer contract
 * stable: static canvas, dynamic canvas, overlay.
 */
export function BoardOverlay(): React.JSX.Element {
  return <div className="board-overlay" data-testid="board-overlay" />
}
