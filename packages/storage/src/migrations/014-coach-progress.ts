export const version = 14;
export const name = 'coach-progress';

export const sql = `
CREATE TABLE IF NOT EXISTS coach_progress (
  step_id TEXT PRIMARY KEY,
  completed_at INTEGER NOT NULL,
  evidence TEXT
);
`;
