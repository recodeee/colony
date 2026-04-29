import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings } from '@colony/config';
import { TaskThread } from '@colony/core';
import kleur from 'kleur';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../src/index.js';
import { withStore } from '../src/util/store.js';

const MINUTE_MS = 60_000;
const NOW = Date.UTC(2026, 3, 28, 12, 0, 0);

let repoRoot: string;
let dataDir: string;
let output: string;
let originalColonyHome: string | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  kleur.enabled = false;
  repoRoot = mkdtempSync(join(tmpdir(), 'colony-cli-rescue-repo-'));
  dataDir = mkdtempSync(join(tmpdir(), 'colony-cli-rescue-data-'));
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

describe('colony rescue CLI', () => {
  it('dry-runs stranded sessions with the operator-facing fields', async () => {
    await seedStrandedSession(['src/a.ts', 'src/b.ts']);

    await createProgram().parseAsync(
      ['node', 'test', 'rescue', 'stranded', '--older-than', '2h', '--dry-run', '--json'],
      { from: 'node' },
    );

    const json = JSON.parse(output) as {
      dry_run: boolean;
      stranded: Array<{
        session_id: string;
        agent: string;
        repo_root: string;
        branch: string;
        last_activity: number;
        held_claim_count: number;
        suggested_action: string;
      }>;
      rescued: unknown[];
      released_claim_count: number;
    };
    expect(json.dry_run).toBe(true);
    expect(json.released_claim_count).toBe(0);
    expect(json.rescued).toEqual([]);
    expect(json.stranded[0]).toMatchObject({
      session_id: 'codex@old',
      agent: 'codex',
      repo_root: repoRoot,
      branch: 'agent/codex/old',
      held_claim_count: 2,
      suggested_action: 'would release 2 claim(s), mark session rescued, keep audit history',
    });
    expect(json.stranded[0]?.last_activity).toBeLessThan(NOW);

    await withStore(loadSettings(), (store) => {
      const task = store.storage.listTasks(10).find((row) => row.branch === 'agent/codex/old');
      expect(task).toBeDefined();
      expect(store.storage.listClaims(task?.id ?? -1)).toHaveLength(2);
      expect(store.storage.getSession('codex@old')?.ended_at).toBeNull();
    });
  });

  it('applies stranded rescue by releasing claims, ending the session, and writing audit', async () => {
    await seedStrandedSession(['src/a.ts']);

    await createProgram().parseAsync(
      ['node', 'test', 'rescue', 'stranded', '--older-than', '2h', '--apply'],
      { from: 'node' },
    );

    expect(output).toContain('Stranded rescue: 1 stranded session(s)');
    expect(output).toContain('mode: apply');
    expect(output).toContain('released claims: 1');
    expect(output).toContain('kept audit history');

    await withStore(loadSettings(), (store) => {
      const task = store.storage.listTasks(10).find((row) => row.branch === 'agent/codex/old');
      expect(task).toBeDefined();
      expect(store.storage.listClaims(task?.id ?? -1)).toEqual([]);
      expect(store.storage.getSession('codex@old')?.ended_at).toBe(NOW);
      const audits = store.storage.timeline('codex@old', undefined, 20).filter((row) => {
        return row.kind === 'rescue-stranded';
      });
      expect(audits).toHaveLength(1);
      expect(JSON.parse(audits[0]?.metadata ?? '{}')).toMatchObject({
        action: 'bulk-release-claims',
        held_claim_count: 1,
        branches: ['agent/codex/old'],
      });
      expect(
        store.storage.timeline('codex@old', undefined, 20).some((row) => row.kind === 'note'),
      ).toBe(true);
    });
  });
});

async function seedStrandedSession(files: string[]): Promise<void> {
  await withStore(loadSettings(), (store) => {
    vi.setSystemTime(NOW - 180 * MINUTE_MS);
    store.startSession({ id: 'codex@old', ide: 'codex', cwd: repoRoot });
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'agent/codex/old',
      title: 'old task',
      session_id: 'codex@old',
    });
    thread.join('codex@old', 'codex');
    for (const file_path of files) {
      thread.claimFile({ session_id: 'codex@old', file_path });
    }
    store.addObservation({
      session_id: 'codex@old',
      kind: 'note',
      task_id: thread.task_id,
      content: 'Historical context must survive rescue cleanup.',
    });
    vi.setSystemTime(NOW);
  });
}
