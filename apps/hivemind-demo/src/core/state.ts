import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createArtifactId, createMessageId, createRunId } from '../utils/ids.js';
import type {
  AgentResult,
  AgentRole,
  ArtifactContent,
  ArtifactType,
  FinalOutput,
  OrchestratorOptions,
  RunArtifact,
  RunCheckpoint,
  RunState,
  RunSubtask,
} from './types.js';

export function createInitialState(task: string, options: OrchestratorOptions): RunState {
  return {
    runId: createRunId(),
    originalTask: task,
    status: 'pending',
    currentPlan: [],
    subtasks: [],
    completedSteps: [],
    messages: [],
    artifacts: [],
    blockers: [],
    checkpoints: [],
    finalResult: null,
    turn: 0,
    maxTurns: options.maxTurns,
    retryCount: 0,
    maxRetries: options.maxRetries,
  };
}

export function applyAgentResult(
  state: RunState,
  role: AgentRole,
  phase: string,
  result: AgentResult,
): RunState {
  const nextState: RunState = {
    ...state,
    status:
      result.runStatus ??
      (result.status === 'failed'
        ? 'failed'
        : state.status === 'pending'
          ? 'in_progress'
          : state.status),
    currentPlan: result.plan ? [...result.plan.steps] : [...state.currentPlan],
    subtasks: result.plan ? result.plan.subtasks.map(cloneSubtask) : state.subtasks.map(cloneSubtask),
    completedSteps: [...state.completedSteps],
    messages: [...state.messages],
    artifacts: [...state.artifacts],
    blockers: result.replaceBlockers ? [...result.replaceBlockers] : [...state.blockers],
    checkpoints: [...state.checkpoints],
    finalResult: result.finalResult ?? state.finalResult,
    turn: state.turn + 1,
  };

  nextState.messages.push({
    id: createMessageId(nextState.turn),
    role,
    phase,
    summary: result.summary,
    details: [...result.details],
    turn: nextState.turn,
    createdAt: new Date().toISOString(),
  });

  if (result.status === 'completed') {
    nextState.completedSteps.push(result.summary);
  }

  if (result.artifact) {
    nextState.artifacts.push(createArtifact(result.artifact.type, result.artifact.label, result.artifact.content, nextState.artifacts.length + 1));
  }

  for (const update of result.markSubtasks ?? []) {
    markSubtask(nextState.subtasks, update.id, update.status, update.note);
  }

  return nextState;
}

export function appendCheckpoint(state: RunState, checkpoint: RunCheckpoint): RunState {
  return {
    ...state,
    checkpoints: [...state.checkpoints, checkpoint],
  };
}

export function incrementRetryCount(state: RunState): RunState {
  return {
    ...state,
    retryCount: state.retryCount + 1,
  };
}

export function findLatestArtifact<T extends ArtifactContent>(
  state: RunState,
  type: ArtifactType,
): RunArtifact<T> | null {
  for (let index = state.artifacts.length - 1; index >= 0; index -= 1) {
    const artifact = state.artifacts[index];
    if (artifact?.type === type) {
      return artifact as RunArtifact<T>;
    }
  }
  return null;
}

export class RunStore {
  readonly runDir: string;

  constructor(dataDir: string, runId: string) {
    this.runDir = join(dataDir, runId);
    mkdirSync(this.runDir, { recursive: true });
  }

  writeState(state: RunState): void {
    writeJson(join(this.runDir, 'state.json'), state);
  }

  writeCheckpoint(checkpoint: RunCheckpoint): void {
    const checkpointDir = join(this.runDir, 'checkpoints');
    mkdirSync(checkpointDir, { recursive: true });
    writeJson(join(checkpointDir, `${checkpoint.id}.json`), checkpoint);
  }

  writeFinal(finalResult: FinalOutput | null): void {
    if (!finalResult) return;
    writeJson(join(this.runDir, 'final-output.json'), finalResult);
  }
}

function createArtifact(
  type: ArtifactType,
  label: string,
  content: ArtifactContent,
  index: number,
): RunArtifact {
  return {
    id: createArtifactId(type, index),
    type,
    label,
    content,
    createdAt: new Date().toISOString(),
  };
}

function markSubtask(
  subtasks: RunSubtask[],
  id: string,
  status: RunSubtask['status'],
  note?: string,
): void {
  const subtask = subtasks.find((entry) => entry.id === id);
  if (!subtask) return;
  subtask.status = status;
  if (note && !subtask.notes.includes(note)) {
    subtask.notes.push(note);
  }
  if (status === 'pending' && note) {
    subtask.retryCount += 1;
  }
}

function cloneSubtask(subtask: RunSubtask): RunSubtask {
  return {
    ...subtask,
    notes: [...subtask.notes],
  };
}

function writeJson(filePath: string, payload: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
