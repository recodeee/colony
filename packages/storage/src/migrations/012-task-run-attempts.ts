export const version = 12;
export const name = 'task-run-attempts';

export const sql = `
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
`;
