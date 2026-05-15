import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  STALE_PROPOSAL_AGE_MS,
  runProposalArchiveJob,
  startProposalArchiveJobLoop,
} from '../../src/jobs/proposals-archive.js';

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
  dir = mkdtempSync(join(tmpdir(), 'colony-worker-proposals-archive-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  db = (store.storage as unknown as StorageWithDb).db;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('proposal archive job', () => {
  it('archives proposed tasks older than seven days and decrements the proposer count', () => {
    const now = 1_800_000_000_000;
    seedProfile('scout-A', 2);
    const staleTaskId = seedProposalTask({
      title: 'old proposal',
      branch: 'proposal/old',
      createdBy: 'scout-A',
      createdAt: now - STALE_PROPOSAL_AGE_MS - 60_000,
    });
    const freshTaskId = seedProposalTask({
      title: 'fresh proposal',
      branch: 'proposal/fresh',
      createdBy: 'scout-A',
      createdAt: now - 60_000,
    });

    const result = runProposalArchiveJob(store, { now: () => now });

    expect(result).toEqual({ archived_count: 1, archived_task_ids: [staleTaskId] });
    expect(taskStatus(staleTaskId)).toBe('archived');
    expect(taskStatus(freshTaskId)).toBe('proposed');
    expect(profileCount('scout-A')).toBe(1);
    const observations = store.storage.taskObservationsByKind(
      staleTaskId,
      'proposal-auto-archived',
      10,
    );
    expect(observations).toHaveLength(1);
    expect(observations[0]?.content).toContain('Auto-archived stale proposal task');
    expect(JSON.parse(observations[0]?.metadata ?? '{}')).toMatchObject({
      proposer: 'scout-A',
      stale_after_ms: STALE_PROPOSAL_AGE_MS,
    });
  });

  it('runNow logs structured JSON for the scheduled worker surface', async () => {
    const now = 1_800_000_000_000;
    seedProfile('scout-A', 1);
    const staleTaskId = seedProposalTask({
      title: 'old proposal',
      branch: 'proposal/logged',
      createdBy: 'scout-A',
      createdAt: now - STALE_PROPOSAL_AGE_MS - 60_000,
    });
    const logs: string[] = [];
    const handle = startProposalArchiveJobLoop({
      store,
      intervalMs: 0,
      now: () => now,
      log: (line) => logs.push(line),
    });

    await handle.runNow();
    await handle.stop();

    expect(JSON.parse(logs[0] ?? '{}')).toEqual({
      component: 'colony-worker',
      job: 'proposals-archive',
      archived_count: 1,
      archived_task_ids: [staleTaskId],
    });
  });
});

function seedProfile(agent: string, openProposalCount: number): void {
  store.storage.upsertAgentProfile({
    agent,
    capabilities: '{}',
    role: 'scout',
    open_proposal_count: openProposalCount,
    updated_at: 1,
  });
}

function seedProposalTask(args: {
  title: string;
  branch: string;
  createdBy: string;
  createdAt: number;
}): number {
  const result = db
    .prepare(
      `INSERT INTO tasks(
         title, repo_root, branch, status, created_by, created_at, updated_at,
         proposal_status, approved_by, observation_evidence_ids
       ) VALUES (?, ?, ?, 'open', ?, ?, ?, 'proposed', NULL, ?)`,
    )
    .run(
      args.title,
      '/repo',
      args.branch,
      args.createdBy,
      args.createdAt,
      args.createdAt,
      JSON.stringify([101]),
    );
  return Number(result.lastInsertRowid);
}

function taskStatus(taskId: number): string | null {
  const row = db.prepare('SELECT proposal_status FROM tasks WHERE id = ?').get(taskId);
  return typeof row?.proposal_status === 'string' ? row.proposal_status : null;
}

function profileCount(agent: string): number {
  const row = store.storage.getAgentProfile(agent);
  return row?.open_proposal_count ?? 0;
}
