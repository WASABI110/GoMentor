-- 0001_init: the library, per-move analysis rows, and the batch ledger.
--
-- Append-only discipline (see .trellis/spec/backend/database-guidelines.md):
-- a later migration may add tables, columns, or indexes, but never renames or
-- drops what an earlier migration created. A shipped migration has run on
-- user machines; editing it in place makes `user_version` a lie. The same
-- reasoning as the error-code enum, one layer down.
--
-- No `WITHOUT ROWID` on `games` deliberately: `list()` breaks most-recent-first
-- ties on `rowid` (a batch import stamps every `imported_at` identically), and
-- a WITHOUT ROWID table has no rowid to order by.

CREATE TABLE games (
  -- The content hash (see sgf/adapter.ts): the same dedupe key the in-memory
  -- Map used as its Map key, so ids are stable across the storage swap.
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  -- The serialised SGF of the retained AST (`StoredGame.collection`). The
  -- projection cannot stand in for it: variations and unknown properties
  -- exist only here (A5 byte-exact round-trip).
  sgf BLOB NOT NULL,
  -- The lossy `Game` projection as JSON. `list()` re-derives summaries from
  -- it via `toSummary`, so there is one definition of what a summary is.
  game_json TEXT NOT NULL,
  -- Tri-state: NULL = unset (name matching decides), 1 = mine, 0 = not mine.
  -- A manual per-game mark outranks name inference (M4 scope decision 2).
  is_mine_override INTEGER,
  -- ISO 8601, set by the importer. `list()` orders on it.
  imported_at TEXT NOT NULL
);

-- Most-recent-first listing. The rowid tie-break is covered in the store, not
-- by the index; the index exists so the common ORDER BY does not sort the
-- whole table as libraries grow.
CREATE INDEX idx_games_imported_at ON games(imported_at);

-- Batch-analysis output: one compact row per move (M4 Stage 2 writes these).
-- candidates/ownership are deliberately absent — they are session-scope data
-- (the sweep precedent); persisting them is out of scope by design.
CREATE TABLE analysis (
  game_id TEXT REFERENCES games(id) ON DELETE CASCADE,
  -- 1-based move number, counting moves (not nodes), matching `Move.number`.
  move_number INTEGER NOT NULL,
  player TEXT NOT NULL,
  winrate REAL NOT NULL,
  score_lead REAL NOT NULL,
  -- The loss attributable to this move (winrate before minus after), the
  -- input the whole profile derives from.
  winrate_loss REAL NOT NULL,
  top_candidate_coord TEXT,
  top_candidate_winrate REAL,
  PRIMARY KEY (game_id, move_number)
);

-- The batch ledger: what has been analysed, so a restart resumes rather than
-- re-analysing. `pending` = queued or interrupted mid-run (a crash turns
-- `pending` back into work), `done` = results committed, `failed` = the game
-- could not be analysed and must not loop forever.
CREATE TABLE batch_state (
  game_id TEXT REFERENCES games(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (game_id)
);
