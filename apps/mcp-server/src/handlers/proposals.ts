import {
  type AgentRole,
  MAX_OPEN_PROPOSALS_PER_SCOUT,
  type MemoryStore,
  TASK_THREAD_ERROR_CODES,
  TaskThreadError,
} from '@colony/core';

type ProposalActorRole = AgentRole | 'operator';

export interface ProposalHandlerContext {
  agent: string;
  session_id?: string;
  now?: () => number;
}

export interface TaskProposeHandlerInput {
  repo_root: string;
  branch: string;
  summary: string;
  rationale?: string;
  touches_files?: string[];
  observationEvidenceIds?: number[];
}

export interface TaskApproveProposalHandlerInput {
  taskId: number;
}

export interface TaskProposeHandlerResult {
  task_id: number;
  proposal_status: 'proposed';
  open_proposal_count: number;
}

export interface TaskApproveProposalHandlerResult {
  task_id: number;
  approved: boolean;
  approved_by: string;
}

export class ProposalHandlerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProposalHandlerError';
    this.code = code;
  }
}

interface SqlRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

interface SqlStatement {
  all(...args: unknown[]): Array<Record<string, unknown>>;
  get(...args: unknown[]): Record<string, unknown> | undefined;
  run(...args: unknown[]): SqlRunResult;
}

interface SqlDatabase {
  prepare(sql: string): SqlStatement;
}

interface StorageWithDb {
  db: SqlDatabase;
}

interface ActorProfile {
  role: ProposalActorRole;
  openProposalCount: number;
}

interface ProposedTaskRow {
  id: number;
  created_by: string;
  proposal_status: string | null;
}

export function handleTaskPropose(
  store: MemoryStore,
  ctx: ProposalHandlerContext,
  input: TaskProposeHandlerInput,
): TaskProposeHandlerResult {
  return store.storage.transaction(
    () => {
      const db = rawDb(store);
      assertProposalSchema(db);
      const actor = loadActorProfile(store, ctx.agent);
      if (actor.role === 'executor') {
        throw new TaskThreadError(
          TASK_THREAD_ERROR_CODES.EXECUTOR_CANNOT_PROPOSE,
          'executors cannot propose; scouts must provide evidence first',
        );
      }
      if (!input.observationEvidenceIds || input.observationEvidenceIds.length === 0) {
        throw new TaskThreadError(
          TASK_THREAD_ERROR_CODES.PROPOSAL_MISSING_EVIDENCE,
          'observationEvidenceIds must contain at least one evidence id',
        );
      }
      if (actor.openProposalCount >= MAX_OPEN_PROPOSALS_PER_SCOUT) {
        throw new TaskThreadError(
          TASK_THREAD_ERROR_CODES.PROPOSAL_CAP_EXCEEDED,
          `scout ${ctx.agent} already has ${MAX_OPEN_PROPOSALS_PER_SCOUT} open proposals`,
        );
      }

      const now = ctx.now?.() ?? Date.now();
      const taskId = insertProposedTask(db, {
        repo_root: input.repo_root,
        branch: input.branch,
        title: input.summary,
        created_by: ctx.agent,
        observationEvidenceIds: input.observationEvidenceIds,
        now,
      });
      const openProposalCount = incrementOpenProposalCount(db, ctx.agent, now);
      return {
        task_id: taskId,
        proposal_status: 'proposed',
        open_proposal_count: openProposalCount,
      };
    },
    { immediate: true },
  );
}

export function handleTaskApproveProposal(
  store: MemoryStore,
  ctx: ProposalHandlerContext,
  input: TaskApproveProposalHandlerInput,
): TaskApproveProposalHandlerResult {
  return store.storage.transaction(
    () => {
      const db = rawDb(store);
      assertProposalSchema(db);
      const actor = loadActorProfile(store, ctx.agent);
      if (actor.role !== 'queen' && actor.role !== 'operator') {
        throw new ProposalHandlerError(
          'APPROVAL_FORBIDDEN',
          'only queen or operator agents can approve proposals',
        );
      }

      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(input.taskId);
      if (!row) {
        throw new TaskThreadError(
          TASK_THREAD_ERROR_CODES.TASK_NOT_FOUND,
          `task ${input.taskId} not found`,
        );
      }

      const task = normalizeProposedTaskRow(row);
      const now = ctx.now?.() ?? Date.now();
      const result = db
        .prepare(
          `UPDATE tasks
             SET proposal_status = 'approved', approved_by = ?, updated_at = ?
           WHERE id = ? AND proposal_status = 'proposed'`,
        )
        .run(ctx.agent, now, input.taskId);
      if (result.changes > 0) {
        decrementOpenProposalCount(db, task.created_by, now);
      }

      return {
        task_id: input.taskId,
        approved: result.changes > 0,
        approved_by: ctx.agent,
      };
    },
    { immediate: true },
  );
}

function rawDb(store: MemoryStore): SqlDatabase {
  return (store.storage as unknown as StorageWithDb).db;
}

function assertProposalSchema(db: SqlDatabase): void {
  const taskColumns = tableColumns(db, 'tasks');
  const profileColumns = tableColumns(db, 'agent_profiles');
  const missing = [
    ...missingColumns(taskColumns, ['proposal_status', 'approved_by', 'observation_evidence_ids']),
    ...missingColumns(profileColumns, ['role', 'open_proposal_count']),
  ];
  if (missing.length > 0) {
    throw new ProposalHandlerError(
      'PROPOSAL_SCHEMA_MISSING',
      `proposal handler schema missing columns: ${missing.join(', ')}`,
    );
  }
}

function tableColumns(db: SqlDatabase, table: 'tasks' | 'agent_profiles'): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((row) => String(row.name)));
}

function missingColumns(columns: Set<string>, required: string[]): string[] {
  return required.filter((column) => !columns.has(column));
}

function loadActorProfile(store: MemoryStore, agent: string): ActorProfile {
  if (agent === 'operator') {
    return { role: 'operator', openProposalCount: 0 };
  }
  const row = store.storage.getAgentProfile(agent) as
    | ({ role?: unknown; open_proposal_count?: unknown } & Record<string, unknown>)
    | undefined;
  return {
    role: normalizeRole(row?.role),
    openProposalCount: numberOrZero(row?.open_proposal_count),
  };
}

function normalizeRole(value: unknown): ProposalActorRole {
  if (value === 'scout' || value === 'executor' || value === 'queen' || value === 'operator') {
    return value;
  }
  return 'executor';
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function insertProposedTask(
  db: SqlDatabase,
  args: {
    repo_root: string;
    branch: string;
    title: string;
    created_by: string;
    observationEvidenceIds: number[];
    now: number;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO tasks(
         title, repo_root, branch, status, created_by, created_at, updated_at,
         proposal_status, approved_by, observation_evidence_ids
       ) VALUES (?, ?, ?, 'open', ?, ?, ?, 'proposed', NULL, ?)`,
    )
    .run(
      args.title,
      args.repo_root,
      args.branch,
      args.created_by,
      args.now,
      args.now,
      JSON.stringify(args.observationEvidenceIds),
    );
  return Number(result.lastInsertRowid);
}

function incrementOpenProposalCount(db: SqlDatabase, agent: string, now: number): number {
  const result = db
    .prepare(
      `UPDATE agent_profiles
          SET open_proposal_count = open_proposal_count + 1,
              updated_at = ?
        WHERE agent = ?`,
    )
    .run(now, agent);
  if (result.changes === 0) return 0;
  const row = db
    .prepare('SELECT open_proposal_count FROM agent_profiles WHERE agent = ?')
    .get(agent);
  return numberOrZero(row?.open_proposal_count);
}

function decrementOpenProposalCount(db: SqlDatabase, agent: string, now: number): void {
  db.prepare(
    `UPDATE agent_profiles
        SET open_proposal_count = CASE
              WHEN open_proposal_count > 0 THEN open_proposal_count - 1
              ELSE 0
            END,
            updated_at = ?
      WHERE agent = ?`,
  ).run(now, agent);
}

function normalizeProposedTaskRow(row: Record<string, unknown>): ProposedTaskRow {
  return {
    id: numberOrZero(row.id),
    created_by: typeof row.created_by === 'string' ? row.created_by : '',
    proposal_status: typeof row.proposal_status === 'string' ? row.proposal_status : null,
  };
}
