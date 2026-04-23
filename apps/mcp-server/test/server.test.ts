import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@cavemem/config';
import { MemoryStore } from '@cavemem/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

let dir: string;
let store: MemoryStore;
let client: Client;

async function seed(): Promise<{ a: number; b: number }> {
  store.startSession({ id: 's1', ide: 'test', cwd: '/tmp' });
  const a = store.addObservation({
    session_id: 's1',
    kind: 'note',
    content: 'The db config lives at /etc/caveman.conf.',
  });
  const b = store.addObservation({
    session_id: 's1',
    kind: 'note',
    content: 'Please just run `cargo build --release` tomorrow.',
  });
  return { a, b };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cavemem-mcp-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  const server = buildServer(store, defaultSettings);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('MCP server', () => {
  it('lists the cavemem tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'agent_get_profile',
      'agent_upsert_profile',
      'get_observations',
      'hivemind',
      'hivemind_context',
      'list_sessions',
      'search',
      'task_accept_handoff',
      'task_claim_file',
      'task_decline_handoff',
      'task_foraging_report',
      'task_hand_off',
      'task_list',
      'task_post',
      'task_propose',
      'task_reinforce',
      'task_timeline',
      'task_updates_since',
      'timeline',
    ]);
  });

  it('hivemind returns compact active-session task state', async () => {
    const repoRoot = join(dir, 'repo');
    const worktreePath = join(repoRoot, '.omx', 'agent-worktrees', 'agent__codex__live-task');
    const activeSessionDir = join(repoRoot, '.omx', 'state', 'active-sessions');
    const now = new Date().toISOString();
    mkdirSync(activeSessionDir, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(
      join(activeSessionDir, 'agent__codex__live-task.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          repoRoot,
          branch: 'agent/codex/live-task',
          taskName: 'Ship hivemind MCP tool',
          latestTaskPreview: 'Expose runtime tasks to Codex',
          agentName: 'codex',
          worktreePath,
          pid: process.pid,
          cliName: 'codex',
          taskMode: 'caveman',
          openspecTier: 'T1',
          taskRoutingReason: 'runtime lookup',
          startedAt: now,
          lastHeartbeatAt: now,
          state: 'working',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const res = await client.callTool({
      name: 'hivemind',
      arguments: { repo_root: repoRoot, limit: 5 },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
    const payload = JSON.parse(text) as {
      session_count: number;
      counts: Record<string, number>;
      sessions: Array<Record<string, unknown>>;
    };

    expect(payload.session_count).toBe(1);
    expect(payload.counts.working).toBe(1);
    expect(payload.sessions[0]).toMatchObject({
      branch: 'agent/codex/live-task',
      task: 'Expose runtime tasks to Codex',
      task_name: 'Ship hivemind MCP tool',
      agent: 'codex',
      activity: 'working',
      source: 'active-session',
      pid_alive: true,
    });
    expect(payload.sessions[0]).not.toHaveProperty('content');
  });

  it('hivemind_context returns lanes plus compact memory hits', async () => {
    const repoRoot = join(dir, 'repo-context');
    const worktreePath = join(repoRoot, '.omx', 'agent-worktrees', 'agent__codex__context-task');
    const activeSessionDir = join(repoRoot, '.omx', 'state', 'active-sessions');
    const now = new Date().toISOString();
    mkdirSync(activeSessionDir, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(
      join(activeSessionDir, 'agent__codex__context-task.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          repoRoot,
          branch: 'agent/codex/context-task',
          taskName: 'Ship hivemind context',
          latestTaskPreview: 'Expose compact context for active lanes',
          agentName: 'codex',
          worktreePath,
          pid: process.pid,
          cliName: 'codex',
          startedAt: now,
          lastHeartbeatAt: now,
          state: 'working',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    store.startSession({ id: 'ctx', ide: 'test', cwd: repoRoot });
    store.addObservation({
      session_id: 'ctx',
      kind: 'note',
      content: 'Hivemind context should fetch compact memory hits before full observations.',
    });

    const res = await client.callTool({
      name: 'hivemind_context',
      arguments: { repo_root: repoRoot, query: 'hivemind context', memory_limit: 2 },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
    const payload = JSON.parse(text) as {
      summary: { lane_count: number; memory_hit_count: number; next_action: string };
      lanes: Array<Record<string, unknown>>;
      memory_hits: Array<Record<string, unknown>>;
    };

    expect(payload.summary.lane_count).toBe(1);
    expect(payload.summary.memory_hit_count).toBeGreaterThan(0);
    expect(payload.summary.next_action).toMatch(/fetch only/);
    expect(payload.lanes[0]).toMatchObject({
      branch: 'agent/codex/context-task',
      owner: 'codex/codex',
      activity: 'working',
      needs_attention: false,
    });
    expect(payload.memory_hits[0]).toHaveProperty('id');
    expect(payload.memory_hits[0]).toHaveProperty('snippet');
    expect(payload.memory_hits[0]).not.toHaveProperty('content');
  });

  it('hivemind falls back to worktree AGENT.lock task previews', async () => {
    const repoRoot = join(dir, 'repo-lock');
    const worktreePath = join(repoRoot, '.omx', 'agent-worktrees', 'agent__codex__proxy-task');
    mkdirSync(join(worktreePath, '.git'), { recursive: true });
    writeFileSync(
      join(worktreePath, '.git', 'HEAD'),
      'ref: refs/heads/agent/codex/proxy-task\n',
      'utf8',
    );
    writeFileSync(
      join(worktreePath, 'AGENT.lock'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          source: 'recodee-live-telemetry',
          updatedAt: '2026-04-23T08:01:00.000Z',
          worktreePath,
          worktreeName: 'agent__codex__proxy-task',
          snapshotCount: 1,
          sessionCount: 1,
          snapshots: [
            {
              snapshotName: 'default',
              email: 'agent@example.com',
              sessions: [
                {
                  sessionKey: 'pid:123',
                  taskPreview: 'Map proxy runtime sessions to current tasks',
                  taskUpdatedAt: '2026-04-23T08:01:00.000Z',
                  projectName: 'recodee',
                  projectPath: worktreePath,
                },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const res = await client.callTool({
      name: 'hivemind',
      arguments: { repo_root: repoRoot, limit: 5 },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
    const payload = JSON.parse(text) as {
      session_count: number;
      sessions: Array<Record<string, unknown>>;
    };

    expect(payload.session_count).toBe(1);
    expect(payload.sessions[0]).toMatchObject({
      branch: 'agent/codex/proxy-task',
      task: 'Map proxy runtime sessions to current tasks',
      source: 'worktree-lock',
      project_name: 'recodee',
      snapshot_name: 'default',
    });
    expect(payload.sessions[0]).not.toHaveProperty('email');
  });

  it('search returns compact hits (id, snippet, score, ts)', async () => {
    await seed();
    const res = await client.callTool({ name: 'search', arguments: { query: 'cargo' } });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '[]';
    const hits = JSON.parse(text) as Array<{ id: number; snippet: string; score: number }>;
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h).toHaveProperty('id');
      expect(h).toHaveProperty('snippet');
      expect(h).toHaveProperty('score');
      // No full body leaks into the compact shape.
      expect(Object.keys(h).sort()).toEqual(['id', 'score', 'session_id', 'snippet', 'ts']);
    }
  });

  it('timeline returns id/kind/ts only (progressive disclosure)', async () => {
    await seed();
    const res = await client.callTool({ name: 'timeline', arguments: { session_id: 's1' } });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '[]';
    const rows = JSON.parse(text) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(['id', 'kind', 'ts']);
    }
  });

  it('get_observations returns expanded text by default and preserves tech tokens', async () => {
    const { a } = await seed();
    const res = await client.callTool({ name: 'get_observations', arguments: { ids: [a] } });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '[]';
    const rows = JSON.parse(text) as Array<{ id: number; content: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toContain('/etc/caveman.conf');
    expect(rows[0]?.content).toMatch(/database/);
  });

  it('get_observations with expand=false returns the compressed stored form', async () => {
    const { b } = await seed();
    const res = await client.callTool({
      name: 'get_observations',
      arguments: { ids: [b], expand: false },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '[]';
    const rows = JSON.parse(text) as Array<{ content: string }>;
    // Compression drops "Please just" but keeps the command intact.
    expect(rows[0]?.content).not.toMatch(/Please just/);
    expect(rows[0]?.content).toContain('`cargo build --release`');
  });

  it('get_observations reports an error on invalid input (empty ids)', async () => {
    const res = await client.callTool({
      name: 'get_observations',
      arguments: { ids: [] },
    });
    expect(res.isError).toBe(true);
  });
});
