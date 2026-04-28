import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore } from '@colony/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

let dataDir: string;
let repoRoot: string;
let store: MemoryStore;
let client: Client;

interface QueenPlanPreview {
  slug: string;
  title: string;
  auto_archive: true;
  subtasks: Array<{ title: string; file_scope: string[]; depends_on: number[] }>;
}

interface QueenPublishResult {
  plan_slug: string;
  spec_task_id: number;
  subtasks: Array<{ subtask_index: number; branch: string; task_id: number; title: string }>;
}

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as T;
}

async function callError(
  name: string,
  args: Record<string, unknown>,
): Promise<{ code: string; error: string; fields: string[]; validation_errors?: string[] }> {
  const res = await client.callTool({ name, arguments: args });
  expect(res.isError).toBe(true);
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as {
    code: string;
    error: string;
    fields: string[];
    validation_errors?: string[];
  };
}

function queenArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    goal_title: 'Build queen MCP surface',
    problem: 'Lead agents need one call that decomposes and publishes work.',
    acceptance_criteria: ['Tool publishes a claimable plan', 'Dry run previews without writes'],
    repo_root: repoRoot,
    affected_files: ['apps/mcp-server/src/tools/queen.ts', 'apps/mcp-server/test/queen.test.ts'],
    session_id: 'lead-session',
    ...overrides,
  };
}

const MINIMAL_SPEC = `# SPEC

## §G  goal
Test fixture spec for queen plan publication tests.

## §C  constraints
- markdown only.

## §I  interfaces
- none

## §V  invariants
id|rule|cites
-|-|-
V1|placeholder|-

## §T  tasks
id|status|task|cites
-|-|-|-
T1|todo|placeholder|V1

## §B  bugs
id|bug|cites
-|-|-
`;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'colony-queen-data-'));
  repoRoot = mkdtempSync(join(tmpdir(), 'colony-queen-repo-'));
  writeFileSync(join(repoRoot, 'SPEC.md'), MINIMAL_SPEC, 'utf8');
  store = new MemoryStore({ dbPath: join(dataDir, 'data.db'), settings: defaultSettings });
  store.startSession({ id: 'lead-session', ide: 'codex', cwd: repoRoot });
  const server = buildServer(store, defaultSettings);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
});

afterEach(async () => {
  await client.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('queen_plan_goal', () => {
  it('previews the queen plan without publishing when dry_run is true', async () => {
    const result = await call<QueenPlanPreview>('queen_plan_goal', queenArgs({ dry_run: true }));

    expect(result.slug).toBe('build-queen-mcp-surface');
    expect(result.title).toBe('Build queen MCP surface');
    expect(result.auto_archive).toBe(true);
    expect(result.subtasks).toHaveLength(2);
    expect(existsSync(join(repoRoot, 'openspec/changes', result.slug, 'CHANGE.md'))).toBe(false);
  });

  it('publishes a claimable queen plan through an MCP client call', async () => {
    const result = await call<QueenPublishResult>('queen_plan_goal', queenArgs());

    expect(result.plan_slug).toBe('build-queen-mcp-surface');
    expect(result.spec_task_id).toEqual(expect.any(Number));
    expect(result.subtasks).toHaveLength(2);
    expect(result.subtasks[0]?.branch).toBe('spec/build-queen-mcp-surface/sub-0');

    const changeText = readFileSync(
      join(repoRoot, 'openspec/changes', result.plan_slug, 'CHANGE.md'),
      'utf8',
    );
    expect(changeText).toContain('Build queen MCP surface');

    const listed = await call<
      Array<{ plan_slug: string; next_available: unknown[]; subtasks: unknown[] }>
    >('task_plan_list', { repo_root: repoRoot });
    const publishedPlan = listed.find((plan) => plan.plan_slug === result.plan_slug);
    expect(publishedPlan?.subtasks).toHaveLength(2);
    expect(publishedPlan?.next_available).toHaveLength(1);
  });

  it('accepts wave ordering hints and publishes task-plan-compatible dependencies', async () => {
    const result = await call<QueenPublishResult>(
      'queen_plan_goal',
      queenArgs({
        affected_files: [
          'apps/api/src/queen-order.ts',
          'apps/web/src/queen/OrderPanel.tsx',
          'apps/api/test/queen-order.test.ts',
        ],
        ordering_hint: 'wave',
        waves: [
          { name: 'UI first', titles: ['Implement web scope'] },
          { name: 'API second', subtask_refs: ['kind:api'] },
        ],
        finalizer: 'Add targeted tests',
      }),
    );

    const listed = await call<
      Array<{
        plan_slug: string;
        next_available: Array<{ title: string }>;
        subtasks: Array<{ title: string; depends_on: number[] }>;
      }>
    >('task_plan_list', { repo_root: repoRoot });
    const publishedPlan = listed.find((plan) => plan.plan_slug === result.plan_slug);

    expect(publishedPlan?.subtasks.map((subtask) => subtask.title)).toEqual([
      'Implement web scope',
      'Implement API scope',
      'Add targeted tests',
    ]);
    expect(publishedPlan?.subtasks.map((subtask) => subtask.depends_on)).toEqual([[], [0], [0, 1]]);
    expect(publishedPlan?.next_available.map((subtask) => subtask.title)).toEqual([
      'Implement web scope',
    ]);
  });

  it('reports ordering validation errors instead of publishing unsafe overlap hints', async () => {
    const err = await callError(
      'queen_plan_goal',
      queenArgs({
        affected_files: ['docs/README.md'],
        ordering_hint: 'wave',
        waves: [
          {
            name: 'docs together',
            titles: ['Prepare README change', 'Update README documentation'],
          },
        ],
      }),
    );

    expect(err.code).toBe('QUEEN_INVALID_GOAL');
    expect(err.fields).toEqual(expect.arrayContaining(['waves']));
    expect(err.validation_errors?.[0]).toContain('overlapping sub-tasks');
  });

  it('returns QUEEN_INVALID_GOAL with invalid fields when queen validation fails', async () => {
    const err = await callError(
      'queen_plan_goal',
      queenArgs({ goal_title: '', acceptance_criteria: [] }),
    );

    expect(err.code).toBe('QUEEN_INVALID_GOAL');
    expect(err.fields).toEqual(expect.arrayContaining(['goal_title', 'acceptance_criteria']));
  });
});
