import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, TaskThread } from '@colony/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

let dir: string;
let repoRoot: string;
let store: MemoryStore;
let client: Client;

interface ValidateResult {
  pairwise_overlaps: Array<{ a: number; b: number; shared: string[] }>;
  live_claim_collisions: Array<{
    subtask_index: number;
    file_path: string;
    holder_session_id: string;
    holder_task_id: number;
    holder_branch: string;
    claimed_at: number;
  }>;
  module_warnings: Array<{ a: number; b: number; shared_modules: string[] }>;
  partition_clean: boolean;
}

async function callValidate(subtasks: unknown[]): Promise<ValidateResult> {
  const res = await client.callTool({
    name: 'task_plan_validate',
    arguments: { repo_root: repoRoot, subtasks },
  });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as ValidateResult;
}

function subtask(
  title: string,
  fileScope: string[],
  dependsOn?: number[],
): Record<string, unknown> {
  return {
    title,
    description: `${title} description`,
    file_scope: fileScope,
    ...(dependsOn !== undefined ? { depends_on: dependsOn } : {}),
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'colony-plan-validate-'));
  repoRoot = join(dir, 'repo');
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  store.startSession({ id: 'A', ide: 'claude-code', cwd: repoRoot });
  store.startSession({ id: 'B', ide: 'codex', cwd: repoRoot });
  const server = buildServer(store, defaultSettings);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
});

afterEach(async () => {
  await client.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('task_plan_validate', () => {
  it('reports a clean partition when scopes and modules are separate', async () => {
    const result = await callValidate([
      subtask('API', ['apps/api/src/widgets.ts']),
      subtask('UI', ['apps/frontend/src/widgets.tsx']),
    ]);

    expect(result.partition_clean).toBe(true);
    expect(result.pairwise_overlaps).toEqual([]);
    expect(result.live_claim_collisions).toEqual([]);
    expect(result.module_warnings).toEqual([]);
  });

  it('reports one pairwise overlap when independent sub-tasks share a file', async () => {
    const result = await callValidate([
      subtask('API one', ['apps/api/src/widgets.ts']),
      subtask('API two', ['apps/api/src/widgets.ts']),
    ]);

    expect(result.partition_clean).toBe(false);
    expect(result.pairwise_overlaps).toEqual([{ a: 0, b: 1, shared: ['apps/api/src/widgets.ts'] }]);
  });

  it('reports a live-claim collision for a currently held scoped file', async () => {
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'agent/codex/held-file',
      session_id: 'A',
    });
    thread.join('A', 'codex');
    thread.claimFile({ session_id: 'A', file_path: 'apps/api/src/widgets.ts' });

    const result = await callValidate([
      subtask('API', ['apps/api/src/widgets.ts']),
      subtask('UI', ['apps/frontend/src/widgets.tsx']),
    ]);

    expect(result.partition_clean).toBe(false);
    expect(result.live_claim_collisions).toMatchObject([
      {
        subtask_index: 0,
        file_path: 'apps/api/src/widgets.ts',
        holder_session_id: 'A',
        holder_branch: 'agent/codex/held-file',
      },
    ]);
  });

  it('warns when independent sub-tasks touch different files in the same module', async () => {
    const result = await callValidate([
      subtask('Core API', ['packages/core/src/api.ts']),
      subtask('Core plan', ['packages/core/src/plan.ts']),
    ]);

    expect(result.partition_clean).toBe(true);
    expect(result.module_warnings).toEqual([{ a: 0, b: 1, shared_modules: ['packages/core/src'] }]);
  });

  it('suppresses same-module warnings for sequenced sub-tasks', async () => {
    const result = await callValidate([
      subtask('Core API', ['packages/core/src/api.ts']),
      subtask('Core plan', ['packages/core/src/plan.ts'], [0]),
    ]);

    expect(result.partition_clean).toBe(true);
    expect(result.module_warnings).toEqual([]);
  });
});
