import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  NewTaskRunAttempt,
  RunAttemptStatus,
  RunAttemptTerminalStatus,
  TaskRunAttemptEventUpdate,
  TaskRunAttemptFinish,
  TaskRunAttemptRow,
} from './types.js';
import {
  RUN_ATTEMPT_ACTIVE_STATUSES,
  RUN_ATTEMPT_TERMINAL_STATUSES,
} from './types.js';

const TERMINAL = new Set<RunAttemptStatus>(RUN_ATTEMPT_TERMINAL_STATUSES);
const ACTIVE = new Set<RunAttemptStatus>(RUN_ATTEMPT_ACTIVE_STATUSES);

export class RunAttemptError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function row(rowAny: unknown): TaskRunAttemptRow | null {
  if (!rowAny) return null;
  return rowAny as TaskRunAttemptRow;
}

function nextAttemptNumber(db: Database.Database, taskId: number, agentId: string): number {
  const r = db
    .prepare(
      'SELECT COALESCE(MAX(attempt_number), 0) AS n FROM task_run_attempts WHERE task_id = ? AND agent_id = ?',
    )
    .get(taskId, agentId) as { n: number } | undefined;
  return (r?.n ?? 0) + 1;
}

export function createRunAttempt(
  db: Database.Database,
  input: NewTaskRunAttempt,
): TaskRunAttemptRow {
  const now = input.started_at ?? Date.now();
  const idempotencyWindowMs = 60_000;
  if (input.workspace_path) {
    const existing = db
      .prepare(
        `SELECT * FROM task_run_attempts
         WHERE task_id = ? AND agent_id = ? AND workspace_path = ?
           AND finished_at IS NULL
           AND started_at >= ?
         ORDER BY started_at DESC
         LIMIT 1`,
      )
      .get(input.task_id, input.agent_id, input.workspace_path, now - idempotencyWindowMs) as
      | TaskRunAttemptRow
      | undefined;
    if (existing) return existing;
  }

  const id = input.id ?? randomUUID();
  const attemptNumber = nextAttemptNumber(db, input.task_id, input.agent_id);
  const status: RunAttemptStatus = input.status ?? 'PreparingWorkspace';
  db.prepare(
    `INSERT INTO task_run_attempts (
       id, task_id, agent_id, attempt_number, workspace_path, status,
       started_at, parent_attempt_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.task_id,
    input.agent_id,
    attemptNumber,
    input.workspace_path,
    status,
    now,
    input.parent_attempt_id ?? null,
  );
  return getRunAttempt(db, id)!;
}

export function getRunAttempt(db: Database.Database, id: string): TaskRunAttemptRow | null {
  return row(db.prepare('SELECT * FROM task_run_attempts WHERE id = ?').get(id));
}

export function listRunAttemptsByTask(
  db: Database.Database,
  taskId: number,
  limit = 50,
): TaskRunAttemptRow[] {
  return db
    .prepare(
      'SELECT * FROM task_run_attempts WHERE task_id = ? ORDER BY started_at DESC LIMIT ?',
    )
    .all(taskId, limit) as TaskRunAttemptRow[];
}

export function updateRunAttemptStatus(
  db: Database.Database,
  id: string,
  status: RunAttemptStatus,
): TaskRunAttemptRow {
  const existing = getRunAttempt(db, id);
  if (!existing) {
    throw new RunAttemptError('ATTEMPT_NOT_FOUND', `run attempt ${id} not found`, { id });
  }
  if (TERMINAL.has(existing.status)) {
    throw new RunAttemptError(
      'ATTEMPT_ALREADY_TERMINAL',
      `run attempt ${id} is already in terminal state ${existing.status}`,
      { id, current_status: existing.status, requested_status: status },
    );
  }
  if (!ACTIVE.has(status) && !TERMINAL.has(status)) {
    throw new RunAttemptError('INVALID_STATUS', `unknown run attempt status: ${status}`, {
      status,
    });
  }
  db.prepare('UPDATE task_run_attempts SET status = ? WHERE id = ?').run(status, id);
  return getRunAttempt(db, id)!;
}

export function recordRunAttemptEvent(
  db: Database.Database,
  id: string,
  update: TaskRunAttemptEventUpdate,
): TaskRunAttemptRow {
  const existing = getRunAttempt(db, id);
  if (!existing) {
    throw new RunAttemptError('ATTEMPT_NOT_FOUND', `run attempt ${id} not found`, { id });
  }
  if (TERMINAL.has(existing.status)) {
    throw new RunAttemptError(
      'ATTEMPT_ALREADY_TERMINAL',
      `cannot record event on terminal attempt ${id} (status=${existing.status})`,
      { id, current_status: existing.status },
    );
  }

  const lastEventAt = update.occurred_at ?? Date.now();
  const inputDelta = update.input_tokens_delta ?? 0;
  const outputDelta = update.output_tokens_delta ?? 0;
  const turnDelta = update.turn_count_delta ?? 0;
  const nextStatus = update.status ?? existing.status;
  if (update.status && !ACTIVE.has(update.status) && !TERMINAL.has(update.status)) {
    throw new RunAttemptError('INVALID_STATUS', `unknown run attempt status: ${update.status}`, {
      status: update.status,
    });
  }

  let truncatedMessage = update.last_event_message ?? null;
  if (truncatedMessage && truncatedMessage.length > 8192) {
    truncatedMessage = truncatedMessage.slice(0, 8192);
  }

  db.prepare(
    `UPDATE task_run_attempts SET
       input_tokens_total = input_tokens_total + ?,
       output_tokens_total = output_tokens_total + ?,
       turn_count = turn_count + ?,
       last_event = COALESCE(?, last_event),
       last_event_at = ?,
       last_event_message = ?,
       status = ?
     WHERE id = ?`,
  ).run(
    inputDelta,
    outputDelta,
    turnDelta,
    update.last_event ?? null,
    lastEventAt,
    truncatedMessage,
    nextStatus,
    id,
  );
  return getRunAttempt(db, id)!;
}

export function finishRunAttempt(
  db: Database.Database,
  id: string,
  finish: TaskRunAttemptFinish,
): TaskRunAttemptRow {
  const existing = getRunAttempt(db, id);
  if (!existing) {
    throw new RunAttemptError('ATTEMPT_NOT_FOUND', `run attempt ${id} not found`, { id });
  }
  if (TERMINAL.has(existing.status)) {
    throw new RunAttemptError(
      'ATTEMPT_ALREADY_TERMINAL',
      `run attempt ${id} is already in terminal state ${existing.status}`,
      { id, current_status: existing.status, requested_status: finish.status },
    );
  }
  const status: RunAttemptTerminalStatus = finish.status;
  if (!TERMINAL.has(status)) {
    throw new RunAttemptError(
      'INVALID_TERMINAL_STATUS',
      `finish requires a terminal status (got ${status})`,
      { status },
    );
  }
  const finishedAt = finish.finished_at ?? Date.now();
  const proofJson = finish.proof === undefined ? null : JSON.stringify(finish.proof);
  db.prepare(
    `UPDATE task_run_attempts SET
       status = ?,
       finished_at = ?,
       error = ?,
       proof_json = COALESCE(?, proof_json)
     WHERE id = ?`,
  ).run(status, finishedAt, finish.error ?? null, proofJson, id);
  return getRunAttempt(db, id)!;
}
