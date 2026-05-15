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

/**
 * One row per completed `colony health --coach` step. Step completion is
 * event-observed; the CLI writes this row the first time the matching
 * `done_when` predicate fires. `evidence` is an opaque short string that
 * the coach renderer can surface as proof (tool name, observation id, etc.).
 */
export interface CoachStepRow {
  step_id: string;
  completed_at: number;
  evidence: string | null;
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
  proposal_status: 'proposed' | 'approved' | 'archived' | null;
  approved_by: string | null;
  observation_evidence_ids: string | null;
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

export type TaskClaimState = 'active' | 'handoff_pending' | 'weak_expired';

export interface TaskClaimRow {
  task_id: number;
  file_path: string;
  session_id: string;
  claimed_at: number;
  state: TaskClaimState;
  expires_at: number | null;
  handoff_observation_id: number | null;
}

export type AccountClaimState = 'active' | 'released';

export interface AccountClaimRow {
  id: number;
  plan_slug: string;
  wave_id: string;
  account_id: string;
  session_id: string | null;
  agent: string | null;
  claimed_at: number;
  state: AccountClaimState;
  expires_at: number | null;
  released_at: number | null;
  released_by_session_id: string | null;
  note: string | null;
}

export interface NewAccountClaim {
  plan_slug: string;
  wave_id: string;
  account_id: string;
  session_id?: string | null;
  agent?: string | null;
  expires_at?: number | null;
  note?: string | null;
}

export type LaneRunState = 'active' | 'paused';

export interface LaneStateRow {
  session_id: string;
  state: LaneRunState;
  reason: string | null;
  updated_at: number;
  updated_by_session_id: string;
}

export interface PausedLaneRow extends LaneStateRow {
  task_id: number | null;
  repo_root: string | null;
  branch: string | null;
  task_title: string | null;
  ide: string | null;
  cwd: string | null;
}

export interface LaneTakeoverResult {
  task_id: number;
  file_path: string;
  previous_session_id: string;
  assigned_session_id: string;
  previous_claimed_at: number;
  weakened_observation_id: number;
  takeover_observation_id: number;
}

export interface TaskLinkRow {
  low_id: number;
  high_id: number;
  created_by: string;
  created_at: number;
  note: string | null;
}

export interface NewTaskLink {
  task_id_a: number;
  task_id_b: number;
  created_by: string;
  note?: string;
}

export interface LinkedTask {
  task_id: number;
  linked_at: number;
  linked_by: string;
  note: string | null;
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
  id: number;
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
  role: 'scout' | 'executor' | 'queen';
  open_proposal_count: number;
  updated_at: number;
}

export interface NewAgentProfile {
  agent: string;
  capabilities: string;
  role?: 'scout' | 'executor' | 'queen';
  open_proposal_count?: number;
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
  kind: string;
  snippet: string;
  score: number;
  ts: number;
  task_id: number | null;
}

export type ExampleManifestKind = 'npm' | 'pypi' | 'cargo' | 'go' | 'unknown';

export interface ExampleRow {
  id: number;
  repo_root: string;
  example_name: string;
  content_hash: string;
  manifest_kind: ExampleManifestKind | null;
  last_scanned_at: number;
  observation_count: number;
}

export interface NewExample {
  repo_root: string;
  example_name: string;
  content_hash: string;
  manifest_kind: ExampleManifestKind | null;
  observation_count?: number;
  last_scanned_at?: number;
}

export interface TaskEmbeddingRow {
  task_id: number;
  model: string;
  dim: number;
  vec: Float32Array;
  observation_count: number;
  computed_at: number;
}

export interface NewTaskEmbedding {
  task_id: number;
  model: string;
  dim: number;
  vec: Float32Array;
  observation_count: number;
  computed_at?: number;
}

export type RunAttemptStatus =
  | 'PreparingWorkspace'
  | 'BuildingPrompt'
  | 'LaunchingAgentProcess'
  | 'InitializingSession'
  | 'StreamingTurn'
  | 'Finishing'
  | 'Succeeded'
  | 'Failed'
  | 'TimedOut'
  | 'Stalled'
  | 'CanceledByReconciliation';

export const RUN_ATTEMPT_TERMINAL_STATUSES = [
  'Succeeded',
  'Failed',
  'TimedOut',
  'Stalled',
  'CanceledByReconciliation',
] as const satisfies ReadonlyArray<RunAttemptStatus>;

export const RUN_ATTEMPT_ACTIVE_STATUSES = [
  'PreparingWorkspace',
  'BuildingPrompt',
  'LaunchingAgentProcess',
  'InitializingSession',
  'StreamingTurn',
  'Finishing',
] as const satisfies ReadonlyArray<RunAttemptStatus>;

export type RunAttemptTerminalStatus = (typeof RUN_ATTEMPT_TERMINAL_STATUSES)[number];

export interface TaskRunAttemptRow {
  id: string;
  task_id: number;
  agent_id: string;
  attempt_number: number;
  workspace_path: string;
  status: RunAttemptStatus;
  started_at: number;
  finished_at: number | null;
  error: string | null;
  parent_attempt_id: string | null;
  input_tokens_total: number;
  output_tokens_total: number;
  turn_count: number;
  last_event: string | null;
  last_event_at: number | null;
  last_event_message: string | null;
  proof_json: string | null;
}

export interface NewTaskRunAttempt {
  id?: string;
  task_id: number;
  agent_id: string;
  workspace_path: string;
  parent_attempt_id?: string | null;
  status?: RunAttemptStatus;
  started_at?: number;
}

export interface TaskRunAttemptEventUpdate {
  input_tokens_delta?: number;
  output_tokens_delta?: number;
  turn_count_delta?: number;
  last_event?: string;
  last_event_message?: string | null;
  status?: RunAttemptStatus;
  occurred_at?: number;
}

export interface TaskRunAttemptFinish {
  status: RunAttemptTerminalStatus;
  error?: string | null;
  finished_at?: number;
  proof?: unknown;
}

export interface NewMcpMetric {
  ts: number;
  operation: string;
  session_id?: string | null;
  repo_root?: string | null;
  input_bytes: number;
  output_bytes: number;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  ok: boolean;
  error_code?: string | null;
  error_message?: string | null;
}

export interface AggregateMcpMetricsOptions {
  since?: number;
  until?: number;
  operation?: string;
  sessionLimit?: number;
  cost?: McpMetricsCostOptions;
}

export interface McpMetricsCostOptions {
  input_usd_per_1m_tokens?: number | undefined;
  output_usd_per_1m_tokens?: number | undefined;
}

export interface McpMetricsCostBasis {
  input_usd_per_1m_tokens: number;
  output_usd_per_1m_tokens: number;
  configured: boolean;
}

export interface McpMetricsAggregateRow {
  operation: string;
  calls: number;
  ok_count: number;
  error_count: number;
  error_reasons: McpMetricsErrorReason[];
  success_tokens: number;
  error_tokens: number;
  avg_success_tokens: number;
  avg_error_tokens: number;
  max_input_tokens: number;
  max_output_tokens: number;
  max_total_tokens: number;
  max_duration_ms: number;
  input_bytes: number;
  output_bytes: number;
  total_bytes: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_cost_usd: number;
  output_cost_usd: number;
  total_cost_usd: number;
  avg_cost_usd: number;
  avg_input_tokens: number;
  avg_output_tokens: number;
  total_duration_ms: number;
  avg_duration_ms: number;
  last_ts: number | null;
}

export interface McpMetricsSessionAggregateRow {
  session_id: string;
  calls: number;
  ok_count: number;
  error_count: number;
  input_bytes: number;
  output_bytes: number;
  total_bytes: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_cost_usd: number;
  output_cost_usd: number;
  total_cost_usd: number;
  avg_cost_usd: number;
  avg_input_tokens: number;
  avg_output_tokens: number;
  total_duration_ms: number;
  avg_duration_ms: number;
  last_ts: number | null;
}

export interface McpMetricsSessionSummary {
  session_count: number;
  sessions_truncated: boolean;
  avg_calls: number;
  avg_input_tokens: number;
  avg_output_tokens: number;
  avg_total_tokens: number;
  avg_total_cost_usd: number;
  last_ts: number | null;
}

export interface McpMetricsErrorReason {
  error_code: string | null;
  error_message: string | null;
  count: number;
  last_ts: number | null;
}

export interface McpMetricsAggregate {
  since: number;
  until: number;
  operation?: string;
  cost_basis: McpMetricsCostBasis;
  totals: McpMetricsAggregateRow;
  operations: McpMetricsAggregateRow[];
  session_summary: McpMetricsSessionSummary;
  sessions: McpMetricsSessionAggregateRow[];
}

export interface AggregateMcpMetricsDailyOptions {
  since?: number;
  until?: number;
  operation?: string;
}

// One row per calendar day in UTC. `day` is 'YYYY-MM-DD'. Used by the
// rtk-style `colony gain --summary` view to render the daily activity
// bar graph and the daily breakdown table.
export interface McpMetricsDailyRow {
  day: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  total_duration_ms: number;
}

export interface McpMetricsRawRow {
  operation: string;
  calls: number;
  ok_count: number;
  in_bytes: number;
  out_bytes: number;
  in_tokens: number;
  out_tokens: number;
  total_ms: number;
  last_ts: number;
}

export interface McpMetricsOperationRawRow extends McpMetricsRawRow {
  success_tokens: number;
  error_tokens: number;
  max_in_tokens: number;
  max_out_tokens: number;
  max_total_tokens: number;
  max_ms: number;
}

export interface McpMetricsSessionRawRow extends Omit<McpMetricsRawRow, 'operation'> {
  session_id: string | null;
}

export interface McpMetricsErrorReasonRawRow {
  operation?: string;
  error_code: string | null;
  error_message: string | null;
  count: number;
  last_ts: number | null;
}
