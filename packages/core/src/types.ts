export interface Observation {
  id: number;
  session_id: string;
  kind: string;
  content: string;
  compressed: boolean;
  intensity: string | null;
  ts: number;
  metadata: Record<string, unknown> | null;
  task_id: number | null;
  reply_to: number | null;
}

export interface Session {
  id: string;
  ide: string;
  cwd: string | null;
  started_at: number;
  ended_at: number | null;
}

export interface SearchResult {
  id: number;
  session_id: string;
  snippet: string;
  score: number;
  ts: number;
}

export interface GetObservationsOptions {
  expand?: boolean;
}
