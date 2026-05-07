import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, TaskThread } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../src/index.js';

const NOW = Date.UTC(2026, 4, 8, 12, 0, 0);
const MINUTE_MS = 60_000;

let dataDir: string;
let repoRoot: string;
let originalColonyHome: string | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  dataDir = mkdtempSync(join(tmpdir(), 'colony-heal-data-'));
  repoRoot = mkdtempSync(join(tmpdir(), 'colony-heal-repo-'));
  originalColonyHome = process.env.COLONY_HOME;
  process.env.COLONY_HOME = dataDir;
});

afterEach(() => {
  if (originalColonyHome === undefined) delete process.env.COLONY_HOME;
  else process.env.COLONY_HOME = originalColonyHome;
  process.exitCode = undefined;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('colony heal', () => {
  it('proposes boring repairs without mutating claims', async () => {
    const store = openStore();
    const seeded = seedHealFixture(store);
    store.close();

    const output = await runCli(['heal', '--json', '--repo-root', repoRoot]);
    const plan = JSON.parse(output) as {
      mode: string;
      summary: {
        actions: number;
        expired_quota_claims: number;
        protected_claim_redirects: number;
      };
      actions: Array<{ type: string; file_path: string }>;
    };

    expect(plan.mode).toBe('propose');
    expect(plan.summary).toMatchObject({
      actions: 2,
      expired_quota_claims: 1,
      protected_claim_redirects: 1,
    });
    expect(plan.actions.map((action) => action.type).sort()).toEqual([
      'redirect-protected-claim',
      'release-expired-quota',
    ]);

    const after = openStore();
    expect(after.storage.getClaim(seeded.quotaTaskId, 'src/quota.ts')).toMatchObject({
      state: 'handoff_pending',
    });
    expect(after.storage.getClaim(seeded.mainTaskId, 'src/main-claim.ts')).toMatchObject({
      state: 'active',
    });
    expect(after.storage.getClaim(seeded.agentTaskId, 'src/main-claim.ts')).toBeUndefined();
    after.close();
  });

  it('applies approved repairs and records searchable repair observations', async () => {
    const store = openStore();
    const seeded = seedHealFixture(store);
    store.close();

    const output = await runCli(['heal', '--apply', '--yes', '--json', '--repo-root', repoRoot]);
    const payload = JSON.parse(output) as {
      results: Array<{ status: string; repair_observation_id: number | null }>;
    };

    expect(payload.results).toEqual([
      expect.objectContaining({ status: 'applied', repair_observation_id: expect.any(Number) }),
      expect.objectContaining({ status: 'applied', repair_observation_id: expect.any(Number) }),
    ]);

    const after = openStore();
    expect(after.storage.getClaim(seeded.quotaTaskId, 'src/quota.ts')).toMatchObject({
      state: 'weak_expired',
    });
    expect(after.storage.getClaim(seeded.mainTaskId, 'src/main-claim.ts')).toBeUndefined();
    expect(after.storage.getClaim(seeded.agentTaskId, 'src/main-claim.ts')).toMatchObject({
      session_id: 'codex@main-owner',
      state: 'active',
    });

    const quotaBaton = after.storage.getObservation(seeded.quotaHandoffId);
    expect(metadata(quotaBaton?.metadata).status).toBe('expired');

    const quotaRepairs = after.storage.taskObservationsByKind(seeded.quotaTaskId, 'repair');
    expect(metadata(quotaRepairs[0]?.metadata)).toMatchObject({
      action: 'release-expired-quota',
      file_path: 'src/quota.ts',
    });
    const redirectRepairs = after.storage.taskObservationsByKind(seeded.mainTaskId, 'repair');
    expect(metadata(redirectRepairs[0]?.metadata)).toMatchObject({
      action: 'redirect-protected-claim',
      file_path: 'src/main-claim.ts',
      target_task_id: seeded.agentTaskId,
    });

    const hits = await after.search('repair', 10);
    expect(hits.some((hit) => hit.session_id === 'colony-heal')).toBe(true);
    after.close();
  });
});

function seedHealFixture(store: MemoryStore): {
  quotaTaskId: number;
  quotaHandoffId: number;
  mainTaskId: number;
  agentTaskId: number;
} {
  const quota = openTask(store, 'agent/codex/quota-lane', 'codex@quota-owner');
  vi.setSystemTime(NOW - 10 * MINUTE_MS);
  quota.claimFile({ session_id: 'codex@quota-owner', file_path: 'src/quota.ts' });
  const quotaHandoffId = quota.handOff({
    from_session_id: 'codex@quota-owner',
    from_agent: 'codex',
    to_agent: 'any',
    summary: 'quota stopped before cleanup',
    reason: 'quota_exhausted',
    expires_in_ms: MINUTE_MS,
  });

  vi.setSystemTime(NOW - 5 * MINUTE_MS);
  const main = openTask(store, 'main', 'codex@main-owner');
  main.claimFile({ session_id: 'codex@main-owner', file_path: 'src/main-claim.ts' });
  const agent = openTask(store, 'agent/codex/main-owner-lane', 'codex@main-owner');
  vi.setSystemTime(NOW);

  return {
    quotaTaskId: quota.task_id,
    quotaHandoffId,
    mainTaskId: main.task_id,
    agentTaskId: agent.task_id,
  };
}

function openTask(store: MemoryStore, branch: string, sessionId: string): TaskThread {
  store.startSession({ id: sessionId, ide: 'codex', cwd: repoRoot });
  const thread = TaskThread.open(store, {
    repo_root: repoRoot,
    branch,
    title: branch,
    session_id: sessionId,
  });
  thread.join(sessionId, 'codex');
  return thread;
}

function openStore(): MemoryStore {
  return new MemoryStore({
    dbPath: join(dataDir, 'data.db'),
    settings: { ...defaultSettings, dataDir },
  });
}

async function runCli(args: string[]): Promise<string> {
  let output = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  try {
    await createProgram().parseAsync(['node', 'test', ...args], { from: 'node' });
  } finally {
    stdout.mockRestore();
  }
  return output;
}

function metadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}
