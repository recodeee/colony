import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, TaskThread } from '@colony/core';
import { Client } from '@modelcontextprotocol/sdk/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server.js';

let dataDir: string;
let repoRoot: string;
let store: MemoryStore;
let client: Client;

interface ReadyResult {
  ready: Array<QuotaRelayReadyEntry>;
  total_available: number;
  next_tool?: string;
  claim_args?: QuotaRelayReadyEntry['claim_args'];
}

interface QuotaRelayReadyEntry {
  kind: 'quota_relay_ready';
  next_tool: 'task_claim_quota_accept';
  task_id: number;
  old_owner: {
    session_id: string;
    agent: string | null;
  };
  files: string[];
  repo_root: string;
  branch: string;
  quota_observation_id: number;
  quota_observation_kind: 'handoff' | 'relay';
  claim_args: {
    task_id: number;
    session_id: string;
    agent: string;
    handoff_observation_id: number;
  };
}

interface AttentionInboxResult {
  summary: {
    weak_other_claim_count: number;
    recent_other_claim_count: number;
    live_file_contention_count: number;
  };
  recent_other_claims: Array<{
    file_path: string;
    by_session_id: string;
    ownership_strength: string;
  }>;
}

interface QuotaAcceptResult {
  status: 'accepted';
  task_id: number;
  handoff_observation_id: number;
  baton_kind: 'handoff' | 'relay';
  accepted_by_session_id: string;
  accepted_files: string[];
  previous_session_ids: string[];
  audit_observation_id: number;
}

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as T;
}

function quotaPendingClaimCount(taskId: number): number {
  return store.storage.listClaims(taskId).filter((claim) => claim.state === 'handoff_pending')
    .length;
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'colony-quota-relay-data-'));
  repoRoot = mkdtempSync(join(tmpdir(), 'colony-quota-relay-repo-'));
  writeFileSync(join(repoRoot, 'SPEC.md'), '# SPEC\n', 'utf8');
  store = new MemoryStore({ dbPath: join(dataDir, 'data.db'), settings: defaultSettings });
  const server = buildServer(store, defaultSettings);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
});

afterEach(async () => {
  vi.useRealTimers();
  await client.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('quota relay lifecycle E2E', () => {
  it('lets a fresh agent accept an old quota-stopped lane exactly once', async () => {
    const startedAt = Date.parse('2026-05-01T10:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(startedAt);

    const sessionA = 'agent-a-quota-stopped';
    const sessionB = 'agent-b-replacement';
    const files = ['apps/api/old-quota-lane.ts', 'apps/api/old-quota-worker.ts'];
    store.startSession({ id: sessionA, ide: 'codex', cwd: repoRoot });
    store.startSession({ id: sessionB, ide: 'codex', cwd: repoRoot });

    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'agent/codex/old-quota-lane',
      session_id: sessionA,
      title: 'Old quota-stopped lane',
    });
    thread.join(sessionA, 'codex');

    for (const file_path of files) {
      await call('task_claim_file', {
        task_id: thread.task_id,
        session_id: sessionA,
        file_path,
      });
    }

    const relay = await call<{ relay_observation_id: number; status: 'pending' }>('task_relay', {
      task_id: thread.task_id,
      session_id: sessionA,
      agent: 'codex',
      reason: 'quota',
      one_line: 'quota stopped while finishing the old lane',
      base_branch: 'main',
      expires_in_minutes: 60,
    });

    expect(quotaPendingClaimCount(thread.task_id)).toBe(2);
    expect(store.storage.listClaims(thread.task_id)).toEqual(
      expect.arrayContaining(
        files.map((file_path) =>
          expect.objectContaining({
            file_path,
            session_id: sessionA,
            state: 'handoff_pending',
            handoff_observation_id: relay.relay_observation_id,
          }),
        ),
      ),
    );

    vi.setSystemTime(startedAt + 5 * 60_000);

    const inbox = await call<AttentionInboxResult>('attention_inbox', {
      session_id: sessionB,
      agent: 'codex',
      repo_root: repoRoot,
      task_ids: [thread.task_id],
      recent_claim_limit: 10,
    });
    expect(inbox.summary.recent_other_claim_count).toBe(0);
    expect(inbox.summary.weak_other_claim_count).toBe(0);
    expect(inbox.summary.live_file_contention_count).toBe(0);
    expect(inbox.recent_other_claims).toEqual([]);

    const ready = await call<ReadyResult>('task_ready_for_agent', {
      session_id: sessionB,
      agent: 'codex',
      repo_root: repoRoot,
      limit: 10,
    });
    const quota = ready.ready[0];
    expect(ready.total_available).toBe(1);
    expect(ready.next_tool).toBe('task_claim_quota_accept');
    expect(quota).toMatchObject({
      kind: 'quota_relay_ready',
      next_tool: 'task_claim_quota_accept',
      task_id: thread.task_id,
      old_owner: { session_id: sessionA, agent: 'codex' },
      files,
      repo_root: repoRoot,
      branch: 'agent/codex/old-quota-lane',
      quota_observation_id: relay.relay_observation_id,
      quota_observation_kind: 'relay',
      claim_args: {
        task_id: thread.task_id,
        session_id: sessionB,
        agent: 'codex',
        handoff_observation_id: relay.relay_observation_id,
      },
    });
    expect(ready.claim_args).toEqual(quota?.claim_args);

    const accepted = await call<QuotaAcceptResult>(quota?.next_tool ?? 'missing_next_tool', {
      ...quota?.claim_args,
    });
    expect(accepted).toMatchObject({
      status: 'accepted',
      task_id: thread.task_id,
      handoff_observation_id: relay.relay_observation_id,
      baton_kind: 'relay',
      accepted_by_session_id: sessionB,
      accepted_files: files,
      previous_session_ids: [sessionA],
    });

    const audit = store.storage.getObservation(accepted.audit_observation_id);
    expect(audit).toMatchObject({
      kind: 'note',
      task_id: thread.task_id,
      reply_to: relay.relay_observation_id,
    });
    expect(audit?.content).toContain('accepted quota-pending claims');
    expect(JSON.parse(audit?.metadata ?? '{}')).toMatchObject({
      audit: 'quota_claim_accept',
      handoff_observation_id: relay.relay_observation_id,
      baton_kind: 'relay',
      accepted_files: files,
      previous_session_ids: [sessionA],
    });

    expect(quotaPendingClaimCount(thread.task_id)).toBe(0);
    expect(store.storage.getParticipantAgent(thread.task_id, sessionB)).toBe('codex');
    expect(store.storage.listClaims(thread.task_id)).toEqual(
      expect.arrayContaining(
        files.map((file_path) =>
          expect.objectContaining({
            file_path,
            session_id: sessionB,
            state: 'active',
            expires_at: null,
            handoff_observation_id: null,
          }),
        ),
      ),
    );
    expect(
      store.storage
        .listClaims(thread.task_id)
        .some((claim) => claim.session_id === sessionA && claim.state === 'active'),
    ).toBe(false);

    const afterInbox = await call<AttentionInboxResult>('attention_inbox', {
      session_id: sessionB,
      agent: 'codex',
      repo_root: repoRoot,
      task_ids: [thread.task_id],
      recent_claim_limit: 10,
    });
    expect(afterInbox.summary.weak_other_claim_count).toBe(0);
    expect(afterInbox.summary.recent_other_claim_count).toBe(0);

    const afterReady = await call<ReadyResult>('task_ready_for_agent', {
      session_id: sessionB,
      agent: 'codex',
      repo_root: repoRoot,
      limit: 10,
    });
    expect(
      afterReady.ready.some(
        (entry) =>
          entry.kind === 'quota_relay_ready' &&
          entry.quota_observation_id === relay.relay_observation_id,
      ),
    ).toBe(false);
    expect(afterReady.next_tool).not.toBe('task_claim_quota_accept');
  });
});
