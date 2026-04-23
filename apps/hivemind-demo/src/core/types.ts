export type StepStatus = 'pending' | 'in_progress' | 'blocked' | 'completed' | 'failed';
export type RunStatus = StepStatus;
export type AgentRole = 'coordinator' | 'researcher' | 'builder' | 'reviewer' | 'verifier';
export type ArtifactType = 'plan' | 'research' | 'build' | 'review' | 'verification';

export interface RunSubtask {
  id: string;
  title: string;
  owner: AgentRole;
  status: StepStatus;
  notes: string[];
  retryCount: number;
}

export interface PlanArtifactContent {
  focus: string[];
  steps: string[];
  subtasks: Array<Pick<RunSubtask, 'id' | 'title' | 'owner'>>;
}

export interface ResearchArtifactContent {
  facts: string[];
  constraints: string[];
  assumptions: string[];
  recommendedFocus: string[];
}

export interface BuildArtifactContent {
  fileTree: string[];
  implementationSteps: string[];
  testPlan: string[];
  checkpointPolicy: string[];
  notes: string[];
}

export interface ReviewArtifactContent {
  approved: boolean;
  strengths: string[];
  issues: string[];
  requiredFixes: string[];
}

export interface VerificationArtifactContent {
  approved: boolean;
  evidence: string[];
  openRisks: string[];
  nextSteps: string[];
}

export type ArtifactContent =
  | PlanArtifactContent
  | ResearchArtifactContent
  | BuildArtifactContent
  | ReviewArtifactContent
  | VerificationArtifactContent;

export interface RunArtifact<T extends ArtifactContent = ArtifactContent> {
  id: string;
  type: ArtifactType;
  label: string;
  content: T;
  createdAt: string;
}

export interface RunMessage {
  id: string;
  role: AgentRole;
  phase: string;
  summary: string;
  details: string[];
  turn: number;
  createdAt: string;
}

export interface RunCheckpoint {
  id: string;
  turn: number;
  goal: string;
  done: string[];
  blocker: string | null;
  nextBatch: string[];
  compactSummary: string;
  createdAt: string;
}

export interface FinalOutput {
  result: string;
  reasoningSummary: string[];
  openRisks: string[];
  nextSteps: string[];
  verified: boolean;
}

export interface RunState {
  runId: string;
  originalTask: string;
  status: RunStatus;
  currentPlan: string[];
  subtasks: RunSubtask[];
  completedSteps: string[];
  messages: RunMessage[];
  artifacts: RunArtifact[];
  blockers: string[];
  checkpoints: RunCheckpoint[];
  finalResult: FinalOutput | null;
  turn: number;
  maxTurns: number;
  retryCount: number;
  maxRetries: number;
}

export interface ArtifactDraft<T extends ArtifactContent = ArtifactContent> {
  type: ArtifactType;
  label: string;
  content: T;
}

export interface PlanDraft {
  steps: string[];
  subtasks: RunSubtask[];
}

export interface AgentInput {
  task: string;
  phase: string;
  attempt: number;
}

export type CoordinatorDecision = 'retry_builder' | 'send_to_verifier' | 'escalate';

export interface AgentResult {
  status: StepStatus;
  summary: string;
  details: string[];
  artifact?: ArtifactDraft;
  plan?: PlanDraft;
  markSubtasks?: Array<{
    id: string;
    status: StepStatus;
    note?: string;
  }>;
  replaceBlockers?: string[];
  decision?: CoordinatorDecision;
  finalResult?: FinalOutput;
  runStatus?: RunStatus;
}

export interface Agent {
  name: string;
  role: AgentRole;
  run(input: AgentInput, state: RunState): AgentResult;
}

export interface HivemindLogger {
  info(message: string): void;
}

export interface OrchestratorOptions {
  dataDir: string;
  maxTurns: number;
  maxRetries: number;
  checkpointInterval: number;
  logger?: HivemindLogger;
}

export interface ModelProvider {
  generate(input: { role: AgentRole; prompt: string; state: RunState }): Promise<string>;
}

export interface ToolRunner {
  invoke(name: string, input: Record<string, unknown>): Promise<unknown>;
}
