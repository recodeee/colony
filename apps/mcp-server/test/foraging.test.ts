import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore } from '@colony/core';
import { scanExamples } from '@colony/foraging';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expandForagingQuery } from '../src/tools/foraging.js';
import { buildServer } from '../src/server.js';

let dir: string;
let repoRoot: string;
let store: MemoryStore;
let client: Client;

function write(rel: string, contents: string): void {
  const abs = join(repoRoot, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, contents);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'colony-mcp-forage-'));
  repoRoot = join(dir, 'repo');
  mkdirSync(repoRoot, { recursive: true });
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  store.startSession({ id: 'mcp-session', ide: 'test', cwd: repoRoot });

  const server = buildServer(store, defaultSettings);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'forage-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function callJson<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const content = (res.content as Array<{ type: string; text: string }>)[0];
  if (!content || content.type !== 'text') throw new Error(`unexpected MCP reply for ${name}`);
  return JSON.parse(content.text) as T;
}

describe('MCP foraging tools', () => {
  it('examples_list returns the compact rows for a scanned repo', async () => {
    write('package.json', JSON.stringify({ name: 'target' }));
    write('examples/stripe/package.json', JSON.stringify({ name: 'stripe' }));
    write('examples/stripe/src/index.ts', 'export {}');
    scanExamples({ repo_root: repoRoot, store, session_id: 'mcp-session' });

    const rows = await callJson<
      Array<{ example_name: string; manifest_kind: string | null; observation_count: number }>
    >('examples_list', { repo_root: repoRoot });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ example_name: 'stripe', manifest_kind: 'npm' });
    expect(rows[0]?.observation_count).toBeGreaterThan(0);
  });

  it('examples_query returns compact hits scoped to foraged-pattern rows', async () => {
    write('package.json', JSON.stringify({ name: 'target' }));
    write(
      'examples/stripe/package.json',
      JSON.stringify({ name: 'stripe', dependencies: { stripe: '^14.0.0' } }),
    );
    scanExamples({ repo_root: repoRoot, store, session_id: 'mcp-session' });
    // Add a *non*-foraged observation with the same keyword — it must not
    // show up in the scoped query.
    store.addObservation({
      session_id: 'mcp-session',
      kind: 'note',
      content: 'A random mention of stripe that should not match a foraged query.',
    });

    const hits = await callJson<Array<{ id: number; snippet: string }>>('examples_query', {
      query: 'stripe',
    });
    expect(hits.length).toBeGreaterThan(0);

    // Every hit id must be a foraged-pattern row.
    for (const h of hits) {
      const row = store.storage.getObservation(h.id);
      expect(row?.kind).toBe('foraged-pattern');
    }
  });

  it('examples_query honors the example_name filter', async () => {
    write('examples/alpha/package.json', JSON.stringify({ name: 'alpha' }));
    write('examples/beta/package.json', JSON.stringify({ name: 'beta' }));
    scanExamples({ repo_root: repoRoot, store, session_id: 'mcp-session' });

    const hits = await callJson<Array<{ id: number }>>('examples_query', {
      query: 'alpha',
      example_name: 'alpha',
    });

    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      const row = store.storage.getObservation(h.id);
      const md = row?.metadata ? (JSON.parse(row.metadata) as { example_name: string }) : null;
      expect(md?.example_name).toBe('alpha');
    }
  });

  it('expands concept aliases for Ruflo-style discovery queries', async () => {
    const expanded = expandForagingQuery('concept=token-budget');
    expect(expanded).toContain('token budget');
    expect(expanded).toContain('hydrate');
  });

  it('examples_integrate_plan returns a deterministic plan', async () => {
    write('package.json', JSON.stringify({ name: 'target', dependencies: { zod: '^3.23.0' } }));
    write(
      'examples/stripe/package.json',
      JSON.stringify({
        name: 'stripe',
        dependencies: { zod: '^3.23.0', stripe: '^14.0.0' },
        scripts: { build: 'tsc' },
      }),
    );
    scanExamples({ repo_root: repoRoot, store, session_id: 'mcp-session' });

    const plan = await callJson<{
      example_name: string;
      dependency_delta: { add: Record<string, string>; remove: string[] };
      config_steps: string[];
    }>('examples_integrate_plan', { repo_root: repoRoot, example_name: 'stripe' });

    expect(plan.example_name).toBe('stripe');
    expect(plan.dependency_delta.add.stripe).toBe('^14.0.0');
    expect(plan.dependency_delta.add.zod).toBeUndefined();
    expect(plan.config_steps).toContain('npm run build');
  });
});
