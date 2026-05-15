import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings } from '@colony/config';
import type { Storage } from '@colony/storage';
import kleur from 'kleur';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../src/index.js';
import { withStore } from '../src/util/store.js';

const BASE_TS = Date.parse('2026-05-15T10:00:00.000Z');

let repoRoot: string;
let dataDir: string;
let output: string;
let originalColonyHome: string | undefined;

interface SqlResult {
  changes?: number;
}

interface SqlStatement {
  run(...args: unknown[]): SqlResult;
}

interface SqlDb {
  prepare(sql: string): SqlStatement;
}

interface StorageWithDb {
  db: SqlDb;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TS);
  kleur.enabled = false;
  repoRoot = mkdtempSync(join(tmpdir(), 'colony-scout-cli-repo-'));
  dataDir = mkdtempSync(join(tmpdir(), 'colony-scout-cli-data-'));
  writeFileSync(join(repoRoot, 'SPEC.md'), '# SPEC\n', 'utf8');
  originalColonyHome = process.env.COLONY_HOME;
  process.env.COLONY_HOME = dataDir;
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  if (originalColonyHome === undefined) delete process.env.COLONY_HOME;
  else process.env.COLONY_HOME = originalColonyHome;
  kleur.enabled = true;
  vi.useRealTimers();
});

describe('colony scout', () => {
  it('lists no proposed scout work on a fresh DB', async () => {
    await createProgram().parseAsync(['node', 'test', 'scout', 'list'], { from: 'node' });

    expect(output).toContain('no proposed scout work');
  });

  it('approves a proposed scout task', async () => {
    const settings = loadSettings();
    let taskId = 0;
    await withStore(settings, (store) => {
      taskId = seedProposal(store.storage, {
        branch: 'scout/proposal-a',
        createdBy: 'scout-a',
        evidence: [100],
      });
    });

    await createProgram().parseAsync(['node', 'test', 'scout', 'approve', String(taskId)], {
      from: 'node',
    });

    expect(output).toContain(`approved #${taskId}`);
    await withStore(settings, (store) => {
      expect(store.storage.getTask(taskId)).toMatchObject({
        proposal_status: 'approved',
        approved_by: process.env.USER?.trim() || 'operator',
      });
    });
  });

  it('rejects a proposed scout task and records the reason', async () => {
    const settings = loadSettings();
    let taskId = 0;
    await withStore(settings, (store) => {
      taskId = seedProposal(store.storage, {
        branch: 'scout/proposal-b',
        createdBy: 'scout-b',
        evidence: [100, 101],
      });
    });

    await createProgram().parseAsync(
      ['node', 'test', 'scout', 'reject', String(taskId), '--reason', 'duplicate'],
      { from: 'node' },
    );

    expect(output).toContain(`rejected #${taskId}`);
    await withStore(settings, (store) => {
      expect(store.storage.getTask(taskId)).toMatchObject({ proposal_status: 'archived' });
      expect(store.storage.taskTimeline(taskId, 10).map((row) => row.content)).toContain(
        'scout proposal rejected: duplicate',
      );
    });
  });
});

function seedProposal(
  storage: Storage,
  args: { branch: string; createdBy: string; evidence: number[] },
): number {
  const task = storage.findOrCreateTask({
    repo_root: repoRoot,
    branch: args.branch,
    title: args.branch,
    created_by: args.createdBy,
  });
  dbFor(storage)
    .prepare(
      `UPDATE tasks
          SET proposal_status = 'proposed',
              observation_evidence_ids = ?,
              created_at = ?,
              updated_at = ?
        WHERE id = ?`,
    )
    .run(JSON.stringify(args.evidence), BASE_TS - 60_000, BASE_TS - 60_000, task.id);
  return task.id;
}

function dbFor(storage: Storage): SqlDb {
  return (storage as unknown as StorageWithDb).db;
}
