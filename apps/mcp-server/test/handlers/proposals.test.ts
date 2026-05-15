import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MAX_OPEN_PROPOSALS_PER_SCOUT, MemoryStore } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  handleTaskApproveProposal,
  handleTaskPropose,
  type ProposalHandlerContext,
} from '../../src/handlers/proposals.js';

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

let dir: string;
let store: MemoryStore;
let db: SqlDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-mcp-proposals-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  db = (store.storage as unknown as StorageWithDb).db;
  installProposalSchema();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('proposal handlers', () => {
  it('rejects missing observation evidence', () => {
    seedProfile('scout-A', 'scout');

    expect(() =>
      handleTaskPropose(store, ctx('scout-A'), {
        repo_root: '/repo',
        branch: 'proposal/missing-evidence',
        summary: 'Add evidence-gated proposals',
      }),
    ).toThrowError(expect.objectContaining({ code: 'PROPOSAL_MISSING_EVIDENCE' }));
  });

  it('rejects scouts at the open proposal cap', () => {
    seedProfile('scout-A', 'scout', MAX_OPEN_PROPOSALS_PER_SCOUT);

    expect(() =>
      handleTaskPropose(store, ctx('scout-A'), {
        repo_root: '/repo',
        branch: 'proposal/capped',
        summary: 'Capped proposal',
        observationEvidenceIds: [101],
      }),
    ).toThrowError(expect.objectContaining({ code: 'PROPOSAL_CAP_EXCEEDED' }));
  });

  it('rejects executor proposals', () => {
    seedProfile('exec-A', 'executor');

    expect(() =>
      handleTaskPropose(store, ctx('exec-A'), {
        repo_root: '/repo',
        branch: 'proposal/executor',
        summary: 'Executor cannot propose',
        observationEvidenceIds: [102],
      }),
    ).toThrowError(expect.objectContaining({ code: 'EXECUTOR_CANNOT_PROPOSE' }));
  });

  it('creates a proposed task thread and increments the scout counter', () => {
    seedProfile('scout-A', 'scout');

    const result = handleTaskPropose(store, ctx('scout-A'), {
      repo_root: '/repo',
      branch: 'proposal/happy',
      summary: 'Happy proposal',
      rationale: 'Evidence exists.',
      touches_files: ['src/a.ts'],
      observationEvidenceIds: [103, 104],
    });

    expect(result).toMatchObject({ proposal_status: 'proposed', open_proposal_count: 1 });
    const task = taskRow(result.task_id);
    expect(task).toMatchObject({
      title: 'Happy proposal',
      repo_root: '/repo',
      branch: 'proposal/happy',
      created_by: 'scout-A',
      proposal_status: 'proposed',
      approved_by: null,
    });
    expect(JSON.parse(String(task.observation_evidence_ids))).toEqual([103, 104]);
    expect(profileCount('scout-A')).toBe(1);
  });

  it('approves a proposed task and decrements the scout counter', () => {
    seedProfile('scout-A', 'scout');
    seedProfile('queen-A', 'queen');
    const proposed = handleTaskPropose(store, ctx('scout-A'), {
      repo_root: '/repo',
      branch: 'proposal/approve',
      summary: 'Approve me',
      observationEvidenceIds: [105],
    });

    const result = handleTaskApproveProposal(store, ctx('queen-A'), {
      taskId: proposed.task_id,
    });

    expect(result).toEqual({
      task_id: proposed.task_id,
      approved: true,
      approved_by: 'queen-A',
    });
    expect(taskRow(proposed.task_id)).toMatchObject({
      proposal_status: 'approved',
      approved_by: 'queen-A',
    });
    expect(profileCount('scout-A')).toBe(0);
  });
});

function ctx(agent: string): ProposalHandlerContext {
  return { agent, session_id: `${agent}-session`, now: () => 1_000 };
}

function installProposalSchema(): void {
  addColumnIfMissing('tasks', 'proposal_status', 'TEXT');
  addColumnIfMissing('tasks', 'approved_by', 'TEXT');
  addColumnIfMissing('tasks', 'observation_evidence_ids', 'TEXT');
  addColumnIfMissing('agent_profiles', 'role', "TEXT NOT NULL DEFAULT 'executor'");
  addColumnIfMissing(
    'agent_profiles',
    'open_proposal_count',
    'INTEGER NOT NULL DEFAULT 0',
  );
}

function addColumnIfMissing(
  table: 'tasks' | 'agent_profiles',
  column: string,
  definition: string,
): void {
  const columns = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)),
  );
  if (!columns.has(column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}

function seedProfile(agent: string, role: string, openProposalCount = 0): void {
  db.prepare(
    `INSERT INTO agent_profiles(agent, capabilities, updated_at, role, open_proposal_count)
     VALUES (?, '{}', 1, ?, ?)`,
  ).run(agent, role, openProposalCount);
}

function profileCount(agent: string): number {
  const row = db
    .prepare('SELECT open_proposal_count FROM agent_profiles WHERE agent = ?')
    .get(agent);
  return Number(row?.open_proposal_count ?? 0);
}

function taskRow(taskId: number): Record<string, unknown> {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!row) throw new Error(`task ${taskId} not found`);
  return row;
}
