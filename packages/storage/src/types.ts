export interface SessionRow {
  id: string;
  ide: string;
  cwd: string | null;
  started_at: number;
  ended_at: number | null;
  metadata: string | null;
}

export interface ObservationRow {
  id: number;
  session_id: string;
  kind: string;
  content: string;
  compressed: 0 | 1;
  intensity: string | null;
  ts: number;
  metadata: string | null;
  task_id: number | null;
  reply_to: number | null;
}

export interface SummaryRow {
  id: number;
  session_id: string;
  scope: 'turn' | 'session';
  content: string;
  compressed: 0 | 1;
  intensity: string | null;
  ts: number;
}

export interface NewObservation {
  session_id: string;
  kind: string;
  content: string;
  compressed: boolean;
  intensity: string | null;
  metadata?: Record<string, unknown>;
  ts?: number;
  task_id?: number | null;
  reply_to?: number | null;
}

export interface TaskRow {
  id: number;
  title: string;
  repo_root: string;
  branch: string;
  status: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface NewTask {
  title: string;
  repo_root: string;
  branch: string;
  created_by: string;
}

export interface TaskParticipantRow {
  task_id: number;
  session_id: string;
  agent: string;
  joined_at: number;
  left_at: number | null;
}

export interface TaskClaimRow {
  task_id: number;
  file_path: string;
  session_id: string;
  claimed_at: number;
}

export interface PheromoneRow {
  task_id: number;
  file_path: string;
  session_id: string;
  strength: number;
  deposited_at: number;
}

export interface NewPheromone {
  task_id: number;
  file_path: string;
  session_id: string;
  strength: number;
  deposited_at: number;
}

export type ProposalStatus = 'pending' | 'active' | 'evaporated';
export type ReinforcementKind = 'explicit' | 'rediscovered' | 'adjacent';

export interface ProposalRow {
  id: number;
  repo_root: string;
  branch: string;
  summary: string;
  rationale: string;
  touches_files: string;
  status: ProposalStatus;
  proposed_by: string;
  proposed_at: number;
  promoted_at: number | null;
  task_id: number | null;
}

export interface NewProposal {
  repo_root: string;
  branch: string;
  summary: string;
  rationale: string;
  touches_files: string;
  proposed_by: string;
  status?: ProposalStatus;
  proposed_at?: number;
}

export interface ReinforcementRow {
  proposal_id: number;
  session_id: string;
  kind: ReinforcementKind;
  weight: number;
  reinforced_at: number;
}

export interface NewReinforcement {
  proposal_id: number;
  session_id: string;
  kind: ReinforcementKind;
  weight: number;
  reinforced_at: number;
}

export interface AgentProfileRow {
  agent: string;
  capabilities: string;
  updated_at: number;
}

export interface NewAgentProfile {
  agent: string;
  capabilities: string;
  updated_at?: number;
}

export interface NewSummary {
  session_id: string;
  scope: 'turn' | 'session';
  content: string;
  compressed: boolean;
  intensity: string | null;
  ts?: number;
}

export interface SearchHit {
  id: number;
  session_id: string;
  snippet: string;
  score: number;
  ts: number;
}
