export type AgentRole = 'scout' | 'executor' | 'queen';

export const MAX_OPEN_PROPOSALS_PER_SCOUT = 3;

export type TaskProposalStatus = 'proposed' | 'approved' | 'archived';

export interface TaskThreadProposalFields {
  proposalStatus?: TaskProposalStatus | null;
  approvedBy?: string | null;
  observationEvidenceIds?: number[];
}

export const SCOUT_PROPOSAL_ERROR_CODES = {
  PROPOSAL_MISSING_EVIDENCE: 'PROPOSAL_MISSING_EVIDENCE',
  PROPOSAL_CAP_EXCEEDED: 'PROPOSAL_CAP_EXCEEDED',
  EXECUTOR_CANNOT_PROPOSE: 'EXECUTOR_CANNOT_PROPOSE',
  SCOUT_NO_CLAIM: 'SCOUT_NO_CLAIM',
} as const;

export type ScoutProposalErrorCode =
  (typeof SCOUT_PROPOSAL_ERROR_CODES)[keyof typeof SCOUT_PROPOSAL_ERROR_CODES];

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
  kind: string;
  snippet: string;
  score: number;
  ts: number;
  task_id: number | null;
}

export interface GetObservationsOptions {
  expand?: boolean;
}
