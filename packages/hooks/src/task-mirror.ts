import {
  type MemoryStore,
  TaskThread,
  detectRepoBranch,
  inferIdeFromSessionId,
} from '@colony/core';
import { stringifyShortUtf8Safe } from './text.js';
import type { HookInput } from './types.js';

const TASK_MIRROR_TOOLS = new Set(['TaskCreate', 'TaskUpdate']);

export interface TaskMirrorResult {
  mirrored: boolean;
  observation_id?: number;
  task_id?: number;
  error?: string;
}

/**
 * Shared hook-side task binding for observed side effects. If the session is
 * already joined to a colony task, use that. Otherwise materialize the same
 * synthetic `agent/<ide>/<session-prefix>` task used by auto-claim.
 */
export function ensureHookTaskForSession(
  store: MemoryStore,
  input: Pick<HookInput, 'session_id' | 'ide' | 'cwd'>,
): number {
  const active = store.storage.findActiveTaskForSession(input.session_id);
  if (active !== undefined) return active;

  const session = store.storage.getSession(input.session_id);
  const cwd = input.cwd ?? session?.cwd ?? null;
  const detected = cwd ? detectRepoBranch(cwd) : null;
  const ide = input.ide ?? session?.ide ?? inferIdeFromSessionId(input.session_id) ?? 'unknown';
  const branch = `agent/${slugSegment(ide)}/${slugSegment(input.session_id).slice(0, 12)}`;

  store.startSession({ id: input.session_id, ide, cwd });
  const thread = TaskThread.open(store, {
    repo_root: detected?.repo_root ?? cwd ?? 'synthetic',
    branch,
    session_id: input.session_id,
  });
  thread.join(input.session_id, ide);
  return thread.task_id;
}

/**
 * Mirror built-in TaskCreate/TaskUpdate tool calls into colony observations.
 * Best-effort only: PostToolUse must keep flowing even when the mirror cannot
 * write.
 */
export function mirrorTaskToolUse(
  store: MemoryStore,
  input: Pick<HookInput, 'session_id' | 'tool_name' | 'tool_input' | 'cwd' | 'ide'>,
): TaskMirrorResult {
  const toolName = input.tool_name ?? '';
  if (!TASK_MIRROR_TOOLS.has(toolName)) return { mirrored: false };

  try {
    const task_id = ensureHookTaskForSession(store, input);
    const metadata: Record<string, unknown> = {
      source: 'task-mirror',
      tool_input: input.tool_input,
      mirrored_at: Date.now(),
    };
    const status_delta =
      toolName === 'TaskUpdate' ? taskUpdateStatusDelta(input.tool_input) : undefined;
    if (status_delta) metadata.status_delta = status_delta;

    const observation_id = store.addObservation({
      session_id: input.session_id,
      kind: toolName === 'TaskCreate' ? 'task-create-mirror' : 'task-update-mirror',
      content:
        toolName === 'TaskCreate'
          ? taskCreateTitle(input.tool_input)
          : taskUpdateContent(status_delta),
      metadata,
      task_id,
    });
    store.storage.touchTask(task_id);
    return { mirrored: observation_id >= 0, observation_id, task_id };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[colony hooks] task-mirror failed: ${error}`);
    return { mirrored: false, error };
  }
}

function taskCreateTitle(toolInput: unknown): string {
  if (isRecord(toolInput)) {
    const title =
      readNonEmptyString(toolInput.title) ??
      readNonEmptyString(toolInput.task_title) ??
      readNonEmptyString(toolInput.name) ??
      readNonEmptyString(toolInput.summary) ??
      readNonEmptyString(toolInput.task);
    if (title) return title;
  }
  return stringifyShort(toolInput) || 'TaskCreate';
}

function taskUpdateStatusDelta(toolInput: unknown): Record<string, unknown> {
  if (!isRecord(toolInput)) return { inferred: false };

  const delta: Record<string, unknown> = {};
  const taskId = readFirstPresent(toolInput, ['task_id', 'taskId', 'id']);
  const fromStatus = readFirstPresent(toolInput, [
    'from_status',
    'old_status',
    'previous_status',
    'prev_status',
    'before_status',
  ]);
  const toStatus = readFirstPresent(toolInput, [
    'to_status',
    'new_status',
    'next_status',
    'after_status',
    'status',
  ]);
  const updates = readFirstPresent(toolInput, ['updates', 'tasks', 'items']);

  if (taskId !== undefined) delta.task_id = taskId;
  if (fromStatus !== undefined) delta.from_status = fromStatus;
  if (toStatus !== undefined) delta.to_status = toStatus;
  if (Array.isArray(updates)) {
    delta.updates = updates.map((update) => taskUpdateStatusDelta(update));
  }
  if (Object.keys(delta).length === 0) delta.inferred = false;
  return delta;
}

function taskUpdateContent(statusDelta: Record<string, unknown> | undefined): string {
  if (!statusDelta) return 'TaskUpdate';
  const taskId = scalarText(statusDelta.task_id);
  const fromStatus = scalarText(statusDelta.from_status);
  const toStatus = scalarText(statusDelta.to_status);
  const prefix = taskId ? `TaskUpdate ${taskId}:` : 'TaskUpdate:';
  if (fromStatus && toStatus) return `${prefix} ${fromStatus} -> ${toStatus}`;
  if (toStatus) return `${prefix} status -> ${toStatus}`;
  return 'TaskUpdate';
}

function readFirstPresent(input: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.hasOwn(input, key) && input[key] !== undefined) return input[key];
  }
  return undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function slugSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function stringifyShort(v: unknown): string {
  return stringifyShortUtf8Safe(v);
}
