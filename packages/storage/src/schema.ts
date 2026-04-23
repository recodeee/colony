export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  ide TEXT NOT NULL,
  cwd TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  compressed INTEGER NOT NULL DEFAULT 1,
  intensity TEXT,
  ts INTEGER NOT NULL,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_observations_ts ON observations(ts);

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK(scope IN ('turn','session')),
  content TEXT NOT NULL,
  compressed INTEGER NOT NULL DEFAULT 1,
  intensity TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_summaries_session ON summaries(session_id, ts);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  content,
  content='observations',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS obs_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO observations_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS embeddings (
  observation_id INTEGER PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model, dim);

-- Task threads: one row per shared objective. Multiple sessions join a task
-- by (repo_root, branch) so two agents on the same branch land in the same
-- thread and can exchange handoffs/claims without reinventing storage.
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  repo_root TEXT NOT NULL,
  branch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(repo_root, branch)
);

CREATE TABLE IF NOT EXISTS task_participants (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  left_at INTEGER,
  PRIMARY KEY (task_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_task_participants_session ON task_participants(session_id);

-- Soft advisory lock. Edits never block on this; the PostToolUse hook (and
-- the next turn's context injection) surface the overlap instead.
CREATE TABLE IF NOT EXISTS task_claims (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_task_claims_session ON task_claims(session_id);

INSERT OR IGNORE INTO schema_version(version) VALUES (3);
`;

/**
 * Column migrations that SQLite's idempotent `CREATE TABLE IF NOT EXISTS`
 * can't express. Each entry is (table, column, add-column SQL). The storage
 * constructor applies any entry whose column is missing and leaves the rest.
 */
export const COLUMN_MIGRATIONS: ReadonlyArray<{ table: string; column: string; sql: string }> = [
  {
    table: 'observations',
    column: 'task_id',
    sql: 'ALTER TABLE observations ADD COLUMN task_id INTEGER REFERENCES tasks(id)',
  },
  {
    table: 'observations',
    column: 'reply_to',
    sql: 'ALTER TABLE observations ADD COLUMN reply_to INTEGER REFERENCES observations(id)',
  },
];

export const POST_MIGRATION_SQL = `
CREATE INDEX IF NOT EXISTS idx_observations_task ON observations(task_id, ts DESC);
`;
