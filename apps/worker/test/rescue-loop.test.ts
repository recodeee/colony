import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsSchema } from '@colony/config';
import { MemoryStore } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startRescueLoop } from '../src/rescue-loop.js';
import { buildApp } from '../src/server.js';

let dir: string;
let store: MemoryStore;

function buildSettings() {
  return SettingsSchema.parse({
    dataDir: dir,
    embedding: {
      provider: 'none',
      model: 'none',
      batchSize: 8,
      autoStart: false,
      idleShutdownMs: 60_000,
    },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-rescue-loop-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: buildSettings() });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('rescue loop', () => {
  it('runs, emits a rescue relay, and weakens stranded claims', async () => {
    const task = seedClaimedTask();
    const logs: string[] = [];
    const handle = startRescueLoop({
      store,
      settings: buildSettings(),
      intervalMs: 10_000,
      log: (line) => logs.push(line),
    });

    await waitFor(() =>
      store.storage.listClaims(task.task_id).every((claim) => claim.state === 'handoff_pending'),
    );
    await handle.stop();

    const relays = store.storage.taskObservationsByKind(task.task_id, 'relay', 10);
    expect(relays).toHaveLength(1);
    expect(store.storage.listClaims(task.task_id)).toEqual([
      expect.objectContaining({
        file_path: 'apps/api/stale.ts',
        state: 'handoff_pending',
        handoff_observation_id: relays[0]?.id,
      }),
    ]);
    expect(handle.lastScan()?.rescued).toHaveLength(1);
    expect(logs.some((line) => /rescue scan stranded=1 rescued=1/.test(line))).toBe(true);
  });

  it("GET /api/colony/stranded returns the loop's latest scan", async () => {
    seedClaimedTask();
    const handle = startRescueLoop({
      store,
      settings: buildSettings(),
      intervalMs: 10_000,
      log: () => {},
    });

    await waitFor(() => handle.lastScan() !== null);
    const latest = handle.lastScan();
    const app = buildApp(store, undefined, { rescueLoop: handle });
    const res = await app.request('/api/colony/stranded');
    await handle.stop();

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stranded: Array<Record<string, unknown>>;
      last_scan_at: number;
      next_scan_at: number;
    };
    expect(body.stranded).toEqual(latest?.stranded);
    expect(body.last_scan_at).toBe(latest?.last_scan_at);
    expect(body.next_scan_at).toBe(latest?.next_scan_at);
  });
});

function seedClaimedTask(): { task_id: number } {
  const repoRoot = join(dir, 'repo');
  const sessionId = 'stale-session';
  const branch = 'agent/codex/stale-task';
  const worktreePath = join(repoRoot, '.omx', 'agent-worktrees', sessionId);
  const activeSessionDir = join(repoRoot, '.omx', 'state', 'active-sessions');
  const startedAt = Date.now() - 20 * 60_000;
  mkdirSync(activeSessionDir, { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(
    join(activeSessionDir, `${sessionId}.json`),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repoRoot,
        branch,
        taskName: 'Stranded task',
        latestTaskPreview: 'Rescue this stranded lane',
        agentName: 'codex',
        worktreePath,
        sessionKey: sessionId,
        cliName: 'codex',
        startedAt: new Date(startedAt).toISOString(),
        lastHeartbeatAt: new Date().toISOString(),
        state: 'working',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  store.storage.createSession({
    id: sessionId,
    ide: 'codex',
    cwd: repoRoot,
    started_at: startedAt,
    metadata: null,
  });
  const task = store.storage.findOrCreateTask({
    title: 'stale-task',
    repo_root: repoRoot,
    branch: 'agent/codex/stale-task',
    created_by: sessionId,
  });
  store.storage.addTaskParticipant({ task_id: task.id, session_id: sessionId, agent: 'codex' });
  store.storage.claimFile({
    task_id: task.id,
    session_id: sessionId,
    file_path: 'apps/api/stale.ts',
  });
  return { task_id: task.id };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for rescue loop');
}
