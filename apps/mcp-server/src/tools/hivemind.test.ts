import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { defaultSettings } from '@colony/config';
import { MemoryStore } from '@colony/core';
import { Client } from '@modelcontextprotocol/sdk/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

let dir: string;
let store: MemoryStore;
let client: Client;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'colony-hivemind-'));
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

describe('hivemind_context performance', () => {
  it('keeps the compact startup path bounded with large telemetry history', async () => {
    const repoRoot = join(dir, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    store.startSession({ id: 'history', ide: 'test', cwd: repoRoot });

    for (let i = 0; i < 2000; i += 1) {
      const tool = i % 10 === 0 ? 'Edit' : 'mcp__colony__task_list';
      store.addObservation({
        session_id: 'history',
        kind: 'tool_use',
        content: tool,
        metadata: {
          tool,
          ...(tool === 'Edit' ? { file_path: `src/file-${i}.ts` } : {}),
        },
      });
    }

    for (let i = 0; i < 500; i += 1) {
      store.addObservation({
        session_id: 'history',
        kind: 'note',
        content: `background observation ${i}`,
      });
    }

    const start = performance.now();
    const res = await client.callTool({
      name: 'hivemind_context',
      arguments: {
        repo_root: repoRoot,
        session_id: 'agent-session',
        agent: 'codex',
        limit: 5,
      },
    });
    const elapsedMs = performance.now() - start;
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
    const payload = JSON.parse(text) as {
      summary: {
        adoption_nudges: unknown[];
        memory_hit_count: number;
        ready_work_count: number;
      };
    };

    expect(elapsedMs).toBeLessThan(500);
    expect(payload.summary.memory_hit_count).toBe(0);
    expect(payload.summary.adoption_nudges).toEqual([]);
    expect(payload.summary.ready_work_count).toBe(0);
  });
});
