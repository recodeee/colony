export const version = 13;
export const name = 'scout-executor-proposals';

export const sql = `
ALTER TABLE tasks ADD COLUMN proposal_status TEXT CHECK(proposal_status IN ('proposed','approved','archived'));
ALTER TABLE tasks ADD COLUMN approved_by TEXT;
ALTER TABLE tasks ADD COLUMN observation_evidence_ids TEXT;

ALTER TABLE agent_profiles ADD COLUMN role TEXT NOT NULL DEFAULT 'executor';
ALTER TABLE agent_profiles ADD COLUMN open_proposal_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_task_threads_proposal_status
  ON tasks(proposal_status)
  WHERE proposal_status IS NOT NULL;
`;
