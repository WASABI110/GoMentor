// Stage 1 skeleton: proves the three-process wiring works end to end.
// Stage 6 replaces this with the real resizable three-panel shell
// (GameList | Board + MoveTree | TeacherChat) and persisted layout.

export function App(): React.JSX.Element {
  return (
    <div className="app-shell">
      <aside className="panel panel--library">
        <h2>棋谱库</h2>
        <p className="placeholder">Stage 6</p>
      </aside>

      <main className="panel panel--board">
        <h2>棋盘</h2>
        <p className="placeholder">Stage 6</p>
        <p className="engine-status">引擎：unavailable</p>
      </main>

      <aside className="panel panel--teacher">
        <h2>AI 教师</h2>
        <p className="placeholder">Stage 6</p>
      </aside>
    </div>
  )
}
