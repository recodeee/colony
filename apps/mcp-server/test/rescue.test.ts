import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore } from '@colony/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/tools/context.js';
import * as rescue from '../src/tools/rescue.js';

let dir: string;
let store: MemoryStore;
let client: Client;
let taskId: number;

interface RescueOutcome {
  dry_run: boolean;
  stranded: Array<Record<string, unknown>>;
  rescued: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'colony-rescue-mcp-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  taskId = seedClaimedTask();

  const server = new McpServer({ name: 'colony-test', version: '0.0.0' });
  const ctx: ToolContext = {
    store,
    settings: defaultSettings,
    resolveEmbedder: async () => null,
  };
  rescue.register(server, ctx);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('rescue stranded MCP tools', () => {
  it('rescue_stranded_scan returns a dry-run outcome and remains read-only', async () => {
    const outcome = await call<RescueOutcome>('rescue_stranded_scan', {
      stranded_after_minutes: 5,
    });

    expect(outcome.dry_run).toBe(true);
    expect(outcome.stranded).toHaveLength(1);
    expect(outcome.rescued).toHaveLength(1);
    expect(store.storage.listClaims(taskId)).toHaveLength(1);
    expect(store.storage.taskObservationsByKind(taskId, 'relay', 10)).toHaveLength(0);
    expect(store.storage.taskTimeline(taskId, 10)).toHaveLength(0);
  });

  it('rescue_stranded_run without confirm: true returns an error', async () => {
    const err = await callError('rescue_stranded_run', {});

    expect(err.code).toBe('RESCUE_CONFIRM_REQUIRED');
    expect(store.storage.listClaims(taskId)).toHaveLength(1);
  });

  it('rescue_stranded_run with confirm: true releases stale claims and returns the rescued list', async () => {
    const outcome = await call<RescueOutcome>('rescue_stranded_run', {
      stranded_after_minutes: 5,
      confirm: true,
    });

    expect(outcome.dry_run).toBe(false);
    expect(outcome.stranded).toHaveLength(1);
    expect(outcome.rescued).toHaveLength(1);
    const auditId = outcome.rescued[0]?.audit_observation_id as number | undefined;
    const audit = store.storage.getObservation(auditId ?? -1);
    expect(audit).toBeDefined();
    expect(audit?.kind).toBe('rescue-stranded');
    expect(store.storage.listClaims(taskId)).toEqual([]);
  });
});

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as T;
}

async function callError(
  name: string,
  args: Record<string, unknown>,
): Promise<{ code: string; error: string }> {
  const res = await client.callTool({ name, arguments: args });
  expect(res.isError).toBe(true);
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as { code: string; error: string };
}

function seedClaimedTask(): number {
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
    branch,
    created_by: sessionId,
  });
  store.storage.addTaskParticipant({ task_id: task.id, session_id: sessionId, agent: 'codex' });
  store.storage.claimFile({
    task_id: task.id,
    session_id: sessionId,
    file_path: 'apps/api/stale.ts',
  });
  return task.id;
}
