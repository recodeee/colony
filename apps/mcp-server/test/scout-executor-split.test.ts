import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore } from '@colony/core';
import { Client } from '@modelcontextprotocol/sdk/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

let dir: string;
let store: MemoryStore;
let client: Client;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'colony-scout-executor-split-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  const server = buildServer(store, defaultSettings);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'scout-executor-split-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('scout -> proposal -> approval -> executor claim', () => {
  it('keeps scouts proposing and executors claiming only approved work', async () => {
    await upsertProfile('scout-A', 'scout');
    await upsertProfile('exec-B', 'executor');
    await upsertProfile('queen-A', 'queen');

    const evidenceIds = seedEvidenceRows();
    const proposed = await call<{
      task_id: number;
      proposal_status: string;
      open_proposal_count: number;
    }>('task_propose', {
      repo_root: '/repo',
      branch: 'spec/scout-e2e/sub-0',
      summary: 'Approved proposal becomes claimable',
      rationale: 'Evidence-backed scout proposal.',
      touches_files: ['src/proposed.ts'],
      observation_evidence_ids: [evidenceIds[0]],
      session_id: 'scout-session',
      agent: 'scout-A',
    });
    expect(proposed).toMatchObject({ proposal_status: 'proposed', open_proposal_count: 1 });
    attachPlanSubtask(proposed.task_id);

    await call('task_propose', proposalArgs('spec/scout-e2e-cap/sub-1', [evidenceIds[0]]));
    await call('task_propose', proposalArgs('spec/scout-e2e-cap/sub-2', [evidenceIds[1]]));
    const capped = await callError('task_propose', proposalArgs('spec/scout-e2e-cap/sub-3', [
      evidenceIds[1],
    ]));
    expect(capped).toMatchObject({ code: 'PROPOSAL_CAP_EXCEEDED' });

    const hidden = await call<{ ready: Array<{ plan_slug: string; subtask_index: number }> }>(
      'task_ready_for_agent',
      {
        repo_root: '/repo',
        session_id: 'exec-session',
        agent: 'exec-B',
      },
    );
    expect(hidden.ready).toEqual([]);

    const executorProposal = await callError('task_propose', {
      repo_root: '/repo',
      branch: 'spec/executor-proposal/sub-0',
      summary: 'Executor proposal',
      rationale: 'Executors should not propose.',
      touches_files: ['src/executor.ts'],
      observation_evidence_ids: [evidenceIds[0]],
      session_id: 'exec-session',
      agent: 'exec-B',
    });
    expect(executorProposal).toMatchObject({ code: 'EXECUTOR_CANNOT_PROPOSE' });

    const scoutClaim = await callError('task_claim_file', {
      task_id: proposed.task_id,
      session_id: 'scout-session',
      agent: 'scout-A',
      file_path: 'src/proposed.ts',
    });
    expect(scoutClaim).toMatchObject({ code: 'SCOUT_NO_CLAIM' });

    const approval = await call<{ task_id: number; approved: boolean; approved_by: string }>(
      'task_approve_proposal',
      {
        task_id: proposed.task_id,
        session_id: 'queen-session',
        agent: 'queen-A',
      },
    );
    expect(approval).toEqual({
      task_id: proposed.task_id,
      approved: true,
      approved_by: 'queen-A',
    });

    const ready = await call<{
      ready: Array<{ task_id: number; plan_slug: string; subtask_index: number }>;
    }>('task_ready_for_agent', {
      repo_root: '/repo',
      session_id: 'exec-session',
      agent: 'exec-B',
    });
    expect(ready.ready).toEqual([
      expect.objectContaining({
        plan_slug: 'scout-e2e',
        subtask_index: 0,
        proposal_status: 'approved',
      }),
    ]);

    const executorClaim = await call<{ status: string; file_path: string }>('task_claim_file', {
      task_id: proposed.task_id,
      session_id: 'exec-session',
      agent: 'exec-B',
      file_path: 'src/proposed.ts',
    });
    expect(executorClaim).toMatchObject({
      file_path: 'src/proposed.ts',
    });
    expect(store.storage.listClaims(proposed.task_id)).toEqual([
      expect.objectContaining({
        task_id: proposed.task_id,
        file_path: 'src/proposed.ts',
        session_id: 'exec-session',
      }),
    ]);
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

async function upsertProfile(agent: string, role: 'scout' | 'executor' | 'queen'): Promise<void> {
  await call('agent_upsert_profile', {
    agent,
    role,
    capabilities: { api_work: 0.9 },
  });
}

function seedEvidenceRows(): [number, number] {
  store.startSession({ id: 'evidence-session', ide: 'test', cwd: '/repo' });
  const first = store.addObservation({
    session_id: 'evidence-session',
    kind: 'cluster_observation',
    content: 'Proposal evidence 100',
  });
  const second = store.addObservation({
    session_id: 'evidence-session',
    kind: 'cluster_observation',
    content: 'Proposal evidence 101',
  });
  return [first, second];
}

function proposalArgs(branch: string, evidence: number[]): Record<string, unknown> {
  return {
    repo_root: '/repo',
    branch,
    summary: `Proposal ${branch}`,
    rationale: 'Evidence-backed scout proposal.',
    touches_files: [`src/${branch.replaceAll('/', '-')}.ts`],
    observation_evidence_ids: evidence,
    session_id: 'scout-session',
    agent: 'scout-A',
  };
}

function attachPlanSubtask(taskId: number): void {
  store.storage.insertObservation({
    session_id: 'scout-session',
    task_id: taskId,
    kind: 'plan-subtask',
    content: 'Approved proposal becomes claimable',
    compressed: true,
    intensity: null,
    metadata: {
      parent_plan_slug: 'scout-e2e',
      parent_plan_title: 'Scout executor e2e',
      parent_spec_task_id: taskId,
      subtask_index: 0,
      title: 'Approved proposal becomes claimable',
      description: 'Executor can claim this only after approval.',
      file_scope: ['src/proposed.ts'],
      depends_on: [],
      capability_hint: 'api_work',
      status: 'available',
    },
  });
}
