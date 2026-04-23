import { createCheckpointId } from '../utils/ids.js';
import type { RunCheckpoint, RunState, StepStatus } from './types.js';

const ACTIVE_STATUSES: StepStatus[] = ['pending', 'in_progress', 'blocked'];

export function shouldCreateCheckpoint(state: RunState, interval: number): boolean {
  if (interval <= 0 || state.turn === 0) return false;
  const lastCheckpointTurn = state.checkpoints[state.checkpoints.length - 1]?.turn ?? 0;
  return state.turn - lastCheckpointTurn >= interval;
}

export function createCheckpoint(state: RunState): RunCheckpoint {
  const done = state.completedSteps.slice(-4);
  const blocker = state.blockers[0] ?? null;
  const nextBatch = state.subtasks
    .filter((subtask) => ACTIVE_STATUSES.includes(subtask.status))
    .slice(0, 3)
    .map((subtask) => subtask.title);
  const compactSummary = [
    `Goal: ${state.originalTask}`,
    `Done: ${done.length > 0 ? done.join('; ') : 'none'}`,
    `Current blocker: ${blocker ?? 'none'}`,
    `Next batch: ${nextBatch.length > 0 ? nextBatch.join('; ') : 'finish verification'}`,
  ].join('\n');

  return {
    id: createCheckpointId(state.checkpoints.length + 1),
    turn: state.turn,
    goal: state.originalTask,
    done: done.length > 0 ? done : ['No completed steps yet.'],
    blocker,
    nextBatch: nextBatch.length > 0 ? nextBatch : ['Return verified final result.'],
    compactSummary,
    createdAt: new Date().toISOString(),
  };
}
