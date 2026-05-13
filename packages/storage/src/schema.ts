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
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','handoff_pending','weak_expired')),
  expires_at INTEGER,
  handoff_observation_id INTEGER REFERENCES observations(id) ON DELETE SET NULL,
  PRIMARY KEY (task_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_task_claims_session ON task_claims(session_id);

-- Account claims: which Codex account a planner wave is "bound to" so multiple
-- operators on the same plan see the same dispatch state. Unlike task_claims
-- (which is keyed by an actual git task/branch), account_claims is keyed by
-- (plan_slug, wave_id) — a logical planner coordinate — so the binding exists
-- before any Colony task has been spawned and survives across the agents that
-- eventually pick the wave up. The partial unique index enforces at most one
-- active claim per wave; released claims stay in the table as audit history.
CREATE TABLE IF NOT EXISTS account_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_slug TEXT NOT NULL,
  wave_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  agent TEXT,
  claimed_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','released')),
  expires_at INTEGER,
  released_at INTEGER,
  released_by_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_account_claims_plan ON account_claims(plan_slug, state);
CREATE INDEX IF NOT EXISTS idx_account_claims_account ON account_claims(account_id, state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_claims_active_wave
  ON account_claims(plan_slug, wave_id)
  WHERE state = 'active';

CREATE TABLE IF NOT EXISTS lane_states (
  session_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('active','paused')),
  reason TEXT,
  updated_at INTEGER NOT NULL,
  updated_by_session_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lane_states_state ON lane_states(state, updated_at DESC);

-- Pheromone trails: ambient, decaying "activity intensity" left on files by
-- tool use. One row per (task_id, file_path, session_id) — different agents
-- leave distinguishable trails so "Claude has been here" is separable from
-- "Codex has been here". Current strength is computed on read via
-- exponential decay from (strength, deposited_at); we never run a cleanup
-- pass, time does the work in the formula.
CREATE TABLE IF NOT EXISTS pheromones (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  strength REAL NOT NULL,
  deposited_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, file_path, session_id)
);
CREATE INDEX IF NOT EXISTS idx_pheromones_task ON pheromones(task_id, deposited_at DESC);

-- Proposals: pre-tasks that become real tasks only when collective
-- reinforcement crosses a threshold. A proposal is a candidate improvement
-- that an agent surfaced but hasn't been adopted yet; it decays with
-- neglect and saturates with support. The distinction from tasks is
-- deliberate — the tasks table is for agreed work, the proposals table
-- is for the foraging queue, and mixing them would turn the task list
-- into a noisy suggestion box.
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_root TEXT NOT NULL,
  branch TEXT NOT NULL,
  summary TEXT NOT NULL,
  rationale TEXT NOT NULL,
  touches_files TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  proposed_by TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  proposed_at INTEGER NOT NULL,
  promoted_at INTEGER,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_proposals_branch ON proposals(repo_root, branch, status);

-- Reinforcements: discrete support rows. Proposal scoring collapses
-- same-session duplicates before summing so one noisy session cannot mimic
-- independent rediscovery, while keeping rows timestamped for decay and for
-- backward-compatible historical data.
CREATE TABLE IF NOT EXISTS proposal_reinforcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  weight REAL NOT NULL,
  reinforced_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reinforcements_proposal ON proposal_reinforcements(proposal_id);

-- Per-agent capability profile. One row per distinct agent identity
-- (not per session — Claude today and Claude tomorrow share the same
-- profile). capabilities is a JSON blob of named dimension -> weight
-- (0..1 typically). JSON rather than normalized columns because the
-- right dimensions won't be obvious until the system runs under load
-- and we want to add new dimensions without migrations.
CREATE TABLE IF NOT EXISTS agent_profiles (
  agent TEXT PRIMARY KEY,
  capabilities TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Cross-task links: bidirectional edges between two tasks so an agent on
-- task A can see B's timeline events in their own preface (e.g. frontend
-- lane needs the backend lane's decisions). Stored once per unordered pair
-- with low_id < high_id so (A,B) and (B,A) collapse into one row, and
-- listing is symmetric: linked_to(A) returns B regardless of which side
-- created the link. Soft-delete is unnecessary — unlinking just drops the
-- row, the underlying tasks are unaffected.
CREATE TABLE IF NOT EXISTS task_links (
  low_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  high_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  note       TEXT,
  PRIMARY KEY (low_id, high_id),
  CHECK (low_id < high_id)
);
CREATE INDEX IF NOT EXISTS idx_task_links_high ON task_links(high_id);

-- Foraging food sources: one row per indexed <repo_root>/examples/<name>.
-- content_hash is sha256 over (manifest + filetree + key file sizes); the
-- scanner uses it to skip work on repeat SessionStarts. observation_count
-- is cached here so listExamples doesn't need to fan out into observations
-- just to render the session-start preface.
CREATE TABLE IF NOT EXISTS examples (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_root         TEXT NOT NULL,
  example_name      TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  manifest_kind     TEXT,
  last_scanned_at   INTEGER NOT NULL,
  observation_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(repo_root, example_name)
);
CREATE INDEX IF NOT EXISTS idx_examples_repo ON examples(repo_root);

-- Task-level embeddings: per-task vector representing the task's "meaning"
-- in the same embedding space the observations live in. Computed lazily
-- the first time a task is queried for similarity (predictive suggestions
-- lane). The vector is a kind-weighted centroid of the task's observation
-- embeddings, so handoffs and decisions count more than tool-use noise.
--
-- observation_count is the cache invalidation key: we recompute when the
-- task's actual observation count drifts more than 20% from the cached
-- value, so older tasks don't pay re-embedding cost on every query while
-- in-flight tasks still see fresh signal as they grow.
--
-- model is the embedder identifier (e.g. 'Xenova/all-MiniLM-L6-v2').
-- Mixing models in the same vector space is meaningless, so a model
-- mismatch invalidates the cache the same way drift does.
CREATE TABLE IF NOT EXISTS task_embeddings (
  task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  observation_count INTEGER NOT NULL,
  computed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_embeddings_model ON task_embeddings(model, dim);

-- Per-call MCP token/duration receipts. One row per tool invocation, recorded
-- by the wrapping handler in apps/mcp-server. input_tokens / output_tokens are
-- estimated via @colony/compress#countTokens — same primitive that produces
-- the observation token receipts, so the numbers line up across surfaces.
-- ok=0 marks a thrown handler so failure rates are queryable.
CREATE TABLE IF NOT EXISTS mcp_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  operation TEXT NOT NULL,
  session_id TEXT,
  repo_root TEXT,
  input_bytes INTEGER NOT NULL,
  output_bytes INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  error_code TEXT,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_mcp_metrics_op_ts ON mcp_metrics(operation, ts DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_metrics_ts ON mcp_metrics(ts DESC);

-- Run-attempt lifecycle rows (Symphony §4.1.5 / §7.2). One row per launch of an
-- agent process against a task; status walks the §7.2 lifecycle from
-- PreparingWorkspace through a terminal state. Rolling event counters
-- (input_tokens_total / output_tokens_total / turn_count / last_event) are
-- updated in place by task_run_attempt_event (Agent 210). Terminal rows are
-- kept for audit — never deleted. parent_attempt_id chains retries.
CREATE TABLE IF NOT EXISTS task_run_attempts (
  id TEXT PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  workspace_path TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error TEXT,
  parent_attempt_id TEXT REFERENCES task_run_attempts(id) ON DELETE SET NULL,
  input_tokens_total INTEGER NOT NULL DEFAULT 0,
  output_tokens_total INTEGER NOT NULL DEFAULT 0,
  turn_count INTEGER NOT NULL DEFAULT 0,
  last_event TEXT,
  last_event_at INTEGER,
  last_event_message TEXT,
  proof_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_run_attempts_task_started
  ON task_run_attempts(task_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_run_attempts_status
  ON task_run_attempts(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_run_attempts_parent
  ON task_run_attempts(parent_attempt_id);

INSERT OR IGNORE INTO schema_version(version) VALUES (12);
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
  {
    table: 'task_claims',
    column: 'state',
    sql: "ALTER TABLE task_claims ADD COLUMN state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','handoff_pending','weak_expired'))",
  },
  {
    table: 'task_claims',
    column: 'expires_at',
    sql: 'ALTER TABLE task_claims ADD COLUMN expires_at INTEGER',
  },
  {
    table: 'task_claims',
    column: 'handoff_observation_id',
    sql: 'ALTER TABLE task_claims ADD COLUMN handoff_observation_id INTEGER REFERENCES observations(id) ON DELETE SET NULL',
  },
  {
    table: 'mcp_metrics',
    column: 'session_id',
    sql: 'ALTER TABLE mcp_metrics ADD COLUMN session_id TEXT',
  },
  {
    table: 'mcp_metrics',
    column: 'repo_root',
    sql: 'ALTER TABLE mcp_metrics ADD COLUMN repo_root TEXT',
  },
  {
    table: 'mcp_metrics',
    column: 'error_code',
    sql: 'ALTER TABLE mcp_metrics ADD COLUMN error_code TEXT',
  },
  {
    table: 'mcp_metrics',
    column: 'error_message',
    sql: 'ALTER TABLE mcp_metrics ADD COLUMN error_message TEXT',
  },
];

export const POST_MIGRATION_SQL = `
CREATE INDEX IF NOT EXISTS idx_observations_task ON observations(task_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_observations_kind_ts ON observations(kind, ts DESC);
CREATE INDEX IF NOT EXISTS idx_observations_session_kind_ts ON observations(session_id, kind, ts DESC);
CREATE INDEX IF NOT EXISTS idx_observations_task_kind_ts ON observations(task_id, kind, ts DESC);
CREATE INDEX IF NOT EXISTS idx_observations_reply_to ON observations(reply_to);
CREATE INDEX IF NOT EXISTS idx_summaries_scope_ts ON summaries(scope, ts DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_metrics_error_ts ON mcp_metrics(ok, error_code, ts DESC);
`;
