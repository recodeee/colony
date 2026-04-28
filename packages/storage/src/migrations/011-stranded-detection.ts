export const version = 11;
export const name = 'stranded-detection';

export const sql = `
CREATE INDEX IF NOT EXISTS idx_sessions_alive_started
  ON sessions(ended_at, started_at);

CREATE INDEX IF NOT EXISTS idx_task_claims_session_claimed
  ON task_claims(session_id, claimed_at DESC);

CREATE INDEX IF NOT EXISTS idx_observations_session_kind_ts
  ON observations(session_id, kind, ts DESC);
`;
