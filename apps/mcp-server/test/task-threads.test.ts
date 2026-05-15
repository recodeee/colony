import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, TASK_THREAD_ERROR_CODES, TaskThread } from '@colony/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server.js';

let dir: string;
let store: MemoryStore;
let client: Client;

/**
 * Every colony tool returns `{ content: [{ type: 'text', text: JSON }] }`.
 * Centralising the unwrap keeps the individual tests readable.
 */
async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as T;
}

async function callError<
  T extends { code: string; error: string } = { code: string; error: string },
>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  expect(res.isError).toBe(true);
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as T;
}

/**
 * Seeds the fixture every task-thread test needs: two participating sessions
 * and a task thread they're both joined to. We bypass the hook layer here
 * because these tests target the MCP surface + storage contract, not hook
 * integration.
 */
function seedTwoSessionTask(repoRoot = '/repo'): {
  task_id: number;
  sessionA: string;
  sessionB: string;
} {
  store.startSession({ id: 'A', ide: 'claude-code', cwd: repoRoot });
  store.startSession({ id: 'B', ide: 'codex', cwd: repoRoot });
  const thread = TaskThread.open(store, {
    repo_root: repoRoot,
    branch: 'feat/handoff',
    session_id: 'A',
  });
  thread.join('A', 'claude');
  thread.join('B', 'codex');
  return { task_id: thread.task_id, sessionA: 'A', sessionB: 'B' };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'colony-task-threads-'));
  // These tests verify claim contention semantics, not branch policy.
  // Disable the protected-branch guard so the existing fixtures (most
  // of which use branch:'main' for brevity) keep exercising the
  // contention-resolution code paths they were written for.
  const settings = { ...defaultSettings, rejectProtectedBranchClaims: false };
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings });
  const server = buildServer(store, settings);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
});

afterEach(async () => {
  vi.useRealTimers();
  await client.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('task threads — file claims', () => {
  it('normalizes task_claim_file paths before storing claims and observations', async () => {
    const repoRoot = mkdtempSync(join(dir, 'repo-'));
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    const { task_id, sessionA } = seedTwoSessionTask(repoRoot);

    const result = await call<{ observation_id: number; file_path: string }>('task_claim_file', {
      task_id,
      session_id: sessionA,
      file_path: join(repoRoot, './src/viewer.tsx'),
    });

    expect(result.file_path).toBe('src/viewer.tsx');
    expect(store.storage.getClaim(task_id, 'src/viewer.tsx')).toMatchObject({
      file_path: 'src/viewer.tsx',
      session_id: sessionA,
    });
    const claim = store.storage.taskObservationsByKind(task_id, 'claim', 1)[0];
    expect(claim?.metadata).toContain('"file_path":"src/viewer.tsx"');
  });

  it('keeps uncontended task_claim_file calls under the hot-path budget', async () => {
    const repoRoot = mkdtempSync(join(dir, 'repo-'));
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    const { task_id, sessionA } = seedTwoSessionTask(repoRoot);
    const durations: number[] = [];

    for (let i = 0; i < 40; i += 1) {
      const started = performance.now();
      const result = await call<{ live_file_contentions: unknown[] }>('task_claim_file', {
        task_id,
        session_id: sessionA,
        file_path: `src/hot-path-${i}.ts`,
      });
      durations.push(performance.now() - started);
      expect(result.live_file_contentions).toEqual([]);
    }

    const p95 = [...durations].sort((a, b) => a - b)[Math.floor(durations.length * 0.95)] ?? 0;
    expect(p95).toBeLessThan(100);
  });

  it('rejects pseudo task_claim_file paths with a pseudo-specific message', async () => {
    const { task_id, sessionA } = seedTwoSessionTask();

    const result = await callError('task_claim_file', {
      task_id,
      session_id: sessionA,
      file_path: '/dev/null',
    });

    expect(result.code).toBe('INVALID_CLAIM_PATH');
    expect(result.error).toBe(
      'claim path "/dev/null" is a pseudo path (e.g. /dev/null) and cannot be claimed.',
    );
    expect(store.storage.listClaims(task_id)).toEqual([]);
  });

  it('rejects directory task_claim_file paths with a directory-specific recovery hint', async () => {
    const { task_id, sessionA } = seedTwoSessionTask();

    // Trailing-slash form: classified as a directory without needing the
    // path to exist on disk, so the assertion stays portable across CI
    // working directories.
    const result = await callError('task_claim_file', {
      task_id,
      session_id: sessionA,
      file_path: 'packages/core/test/',
    });

    expect(result.code).toBe('INVALID_CLAIM_PATH');
    expect(result.error).toBe(
      'claim path "packages/core/test/" is a directory; claim individual files inside it instead.',
    );
    expect(store.storage.listClaims(task_id)).toEqual([]);
  });

  it('returns weak stale overlap details without deleting the audit claim', async () => {
    const t0 = Date.parse('2026-04-28T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();

    await call('task_claim_file', {
      task_id,
      session_id: sessionA,
      file_path: 'src/viewer.tsx',
    });

    vi.setSystemTime(t0 + 241 * 60_000);
    const result = await call<{
      observation_id: number;
      overlap: string;
      previous_claim: {
        by_session_id: string;
        file_path: string;
        age_class: string;
        ownership_strength: string;
        overlap: string;
      };
    }>('task_claim_file', {
      task_id,
      session_id: sessionB,
      file_path: 'src/viewer.tsx',
    });

    expect(result.overlap).toBe('weak_stale');
    expect(result.previous_claim).toMatchObject({
      by_session_id: sessionA,
      file_path: 'src/viewer.tsx',
      age_class: 'stale',
      ownership_strength: 'weak',
      overlap: 'weak_stale',
    });
    expect(store.storage.taskObservationsByKind(task_id, 'claim', 10)).toHaveLength(2);
  });

  it('refreshes a same-session scoped claim instead of creating duplicate contention', async () => {
    const repoRoot = mkdtempSync(join(dir, 'repo-'));
    const repoAlias = `${repoRoot}/../${basename(repoRoot)}`;
    store.startSession({ id: 'same-session', ide: 'codex', cwd: repoRoot });

    const first = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'main',
      session_id: 'same-session',
    });
    first.join('same-session', 'codex');
    await call('task_claim_file', {
      task_id: first.task_id,
      session_id: 'same-session',
      file_path: 'src/protected.ts',
    });

    const second = TaskThread.open(store, {
      repo_root: repoAlias,
      branch: 'main',
      session_id: 'same-session',
    });
    second.join('same-session', 'codex');
    const result = await call<{ claim_status: string; claim_task_id: number }>('task_claim_file', {
      task_id: second.task_id,
      session_id: 'same-session',
      file_path: 'src/protected.ts',
    });

    expect(result).toMatchObject({
      claim_status: 'refreshed_same_session',
      claim_task_id: first.task_id,
    });
    expect(store.storage.getClaim(first.task_id, 'src/protected.ts')?.session_id).toBe(
      'same-session',
    );
    expect(store.storage.getClaim(second.task_id, 'src/protected.ts')).toBeUndefined();
  });

  it('supersedes an inactive clean scoped owner without creating duplicate contention', async () => {
    const repoRoot = mkdtempSync(join(dir, 'repo-'));
    const repoAlias = `${repoRoot}/../${basename(repoRoot)}`;
    const filePath = 'apps/cli/src/commands/health.ts';
    store.startSession({ id: 'inactive-owner', ide: 'codex', cwd: repoRoot });
    store.startSession({ id: 'requester', ide: 'codex', cwd: repoRoot });

    const first = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'main',
      session_id: 'inactive-owner',
    });
    first.join('inactive-owner', 'codex');
    first.claimFile({ session_id: 'inactive-owner', file_path: filePath });
    store.endSession('inactive-owner');
    const second = TaskThread.open(store, {
      repo_root: repoAlias,
      branch: 'main',
      session_id: 'requester',
    });
    second.join('requester', 'codex');

    const result = await call<{ claim_status: string; claim_task_id: number }>('task_claim_file', {
      task_id: second.task_id,
      session_id: 'requester',
      file_path: filePath,
    });

    expect(result).toMatchObject({
      claim_status: 'superseded_inactive_owner',
      claim_task_id: first.task_id,
    });
    expect(store.storage.getClaim(first.task_id, filePath)).toMatchObject({
      session_id: 'requester',
      file_path: filePath,
    });
    expect(store.storage.getClaim(second.task_id, filePath)).toBeUndefined();
  });

  it('blocks a dirty inactive scoped owner until handoff or rescue', async () => {
    const repoRoot = mkdtempSync(join(dir, 'repo-'));
    const repoAlias = `${repoRoot}/../${basename(repoRoot)}`;
    const filePath = 'apps/cli/src/commands/health.ts';
    const dirtyWorktree = join(repoRoot, '.omx', 'agent-worktrees', 'owner');
    mkdirSync(join(dirtyWorktree, 'apps', 'cli', 'src', 'commands'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: dirtyWorktree, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: dirtyWorktree,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Test User'], {
      cwd: dirtyWorktree,
      stdio: 'ignore',
    });
    writeFileSync(join(dirtyWorktree, 'README.md'), 'base\n');
    execFileSync('git', ['add', 'README.md'], { cwd: dirtyWorktree, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: dirtyWorktree, stdio: 'ignore' });
    writeFileSync(join(dirtyWorktree, filePath), 'dirty\n');
    store.startSession({ id: 'inactive-owner', ide: 'codex', cwd: dirtyWorktree });
    store.startSession({ id: 'requester', ide: 'codex', cwd: repoRoot });

    const first = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'main',
      session_id: 'inactive-owner',
    });
    first.join('inactive-owner', 'codex');
    first.claimFile({ session_id: 'inactive-owner', file_path: filePath });
    store.endSession('inactive-owner');
    const second = TaskThread.open(store, {
      repo_root: repoAlias,
      branch: 'main',
      session_id: 'requester',
    });
    second.join('requester', 'codex');

    const err = await callError('task_claim_file', {
      task_id: second.task_id,
      session_id: 'requester',
      file_path: filePath,
    });

    expect(err).toMatchObject({
      code: 'CLAIM_TAKEOVER_RECOMMENDED',
      owner_session_id: 'inactive-owner',
      owner_active: false,
      owner_dirty: true,
    });
    expect(store.storage.getClaim(first.task_id, filePath)?.session_id).toBe('inactive-owner');
    expect(store.storage.getClaim(second.task_id, filePath)).toBeUndefined();
  });

  it('blocks a scoped claim when an active different owner holds it', async () => {
    const repoRoot = mkdtempSync(join(dir, 'repo-'));
    const repoAlias = `${repoRoot}/../${basename(repoRoot)}`;
    store.startSession({ id: 'active-owner', ide: 'claude-code', cwd: repoRoot });
    store.startSession({ id: 'requester', ide: 'codex', cwd: repoRoot });

    const first = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'main',
      session_id: 'active-owner',
    });
    first.join('active-owner', 'claude');
    first.claimFile({ session_id: 'active-owner', file_path: 'src/protected.ts' });
    const second = TaskThread.open(store, {
      repo_root: repoAlias,
      branch: 'main',
      session_id: 'requester',
    });
    second.join('requester', 'codex');

    const err = await callError('task_claim_file', {
      task_id: second.task_id,
      session_id: 'requester',
      file_path: 'src/protected.ts',
    });

    expect(err).toMatchObject({
      code: 'CLAIM_HELD_BY_ACTIVE_OWNER',
      owner_session_id: 'active-owner',
      owner_active: true,
    });
    expect(store.storage.getClaim(second.task_id, 'src/protected.ts')).toBeUndefined();
  });

  it('treats protected files as stricter than ordinary same-agent claims', async () => {
    const repoRoot = mkdtempSync(join(dir, 'repo-'));
    const repoAlias = `${repoRoot}/../${basename(repoRoot)}`;
    store.startSession({ id: 'active-owner', ide: 'codex', cwd: repoRoot });
    store.startSession({ id: 'requester', ide: 'codex', cwd: repoRoot });

    const first = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'main',
      session_id: 'active-owner',
    });
    first.join('active-owner', 'codex');
    first.claimFile({ session_id: 'active-owner', file_path: 'src/ordinary.ts' });
    first.claimFile({ session_id: 'active-owner', file_path: 'apps/cli/src/commands/health.ts' });
    const second = TaskThread.open(store, {
      repo_root: repoAlias,
      branch: 'main',
      session_id: 'requester',
    });
    second.join('requester', 'codex');

    const ordinary = await call<{ claim_status: string; claim_task_id: number }>(
      'task_claim_file',
      {
        task_id: second.task_id,
        session_id: 'requester',
        file_path: 'src/ordinary.ts',
      },
    );
    const protectedErr = await callError('task_claim_file', {
      task_id: second.task_id,
      session_id: 'requester',
      file_path: 'apps/cli/src/commands/health.ts',
    });

    expect(ordinary).toMatchObject({
      claim_status: 'refreshed_same_lane',
      claim_task_id: first.task_id,
    });
    expect(protectedErr).toMatchObject({
      code: 'CLAIM_HELD_BY_ACTIVE_OWNER',
      owner_session_id: 'active-owner',
      owner_active: true,
    });
    expect(store.storage.getClaim(first.task_id, 'src/ordinary.ts')?.session_id).toBe('requester');
    expect(store.storage.getClaim(second.task_id, 'src/ordinary.ts')).toBeUndefined();
    expect(
      store.storage.getClaim(first.task_id, 'apps/cli/src/commands/health.ts')?.session_id,
    ).toBe('active-owner');
    expect(
      store.storage.getClaim(second.task_id, 'apps/cli/src/commands/health.ts'),
    ).toBeUndefined();
  });
});

describe('task threads — handoff lifecycle', () => {
  it('transfers file claims atomically when a handoff is accepted', async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();

    // A claims the file it's about to hand off.
    await call('task_claim_file', {
      task_id,
      session_id: sessionA,
      file_path: 'src/viewer.tsx',
    });

    // A posts the handoff naming the file as transferred.
    const { handoff_observation_id } = await call<{ handoff_observation_id: number }>(
      'task_hand_off',
      {
        task_id,
        session_id: sessionA,
        agent: 'claude',
        to_agent: 'codex',
        summary: 'viewer is done, API is next',
        transferred_files: ['src/viewer.tsx'],
      },
    );

    // Between handoff and accept the claim must be vacant — otherwise a
    // third agent racing in the gap could grab the file.
    expect(store.storage.getClaim(task_id, 'src/viewer.tsx')).toBeUndefined();

    const accepted = await call<{ status: string }>('task_accept_handoff', {
      handoff_observation_id,
      session_id: sessionB,
    });
    expect(accepted.status).toBe('accepted');

    // Claim migrated to B.
    const claim = store.storage.getClaim(task_id, 'src/viewer.tsx');
    expect(claim?.session_id).toBe(sessionB);

    // Handoff metadata reflects acceptance. Reading the observation directly
    // because `get_observations` doesn't expose metadata mutation state.
    const handoff = store.storage.getObservation(handoff_observation_id);
    const meta = JSON.parse(handoff?.metadata ?? '{}');
    expect(meta.status).toBe('accepted');
    expect(meta.accepted_by_session_id).toBe(sessionB);
  });

  it('declining a handoff cancels it and records a reason', async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();

    const { handoff_observation_id } = await call<{ handoff_observation_id: number }>(
      'task_hand_off',
      {
        task_id,
        session_id: sessionA,
        agent: 'claude',
        to_agent: 'codex',
        summary: 'take the API',
        transferred_files: ['src/api.ts'],
      },
    );

    await call('task_decline_handoff', {
      handoff_observation_id,
      session_id: sessionB,
      reason: 'I am mid-turn on another task',
    });

    // Declined handoffs MUST NOT transfer claims. Silent claim transfer to
    // a session that refused the work would be the ugliest failure mode.
    expect(store.storage.getClaim(task_id, 'src/api.ts')).toBeUndefined();

    const handoff = store.storage.getObservation(handoff_observation_id);
    const meta = JSON.parse(handoff?.metadata ?? '{}');
    expect(meta.status).toBe('cancelled');

    // Decline should be discoverable in the timeline so the sender's next
    // turn can render "B declined: <reason>" via the hook.
    const timeline = await call<Array<{ id: number; kind: string }>>('task_timeline', { task_id });
    expect(timeline.some((r) => r.kind === 'decline')).toBe(true);
  });

  it('rejects acceptance after the handoff has expired', async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();

    const { handoff_observation_id } = await call<{ handoff_observation_id: number }>(
      'task_hand_off',
      {
        task_id,
        session_id: sessionA,
        agent: 'claude',
        to_agent: 'codex',
        summary: 'urgent',
        expires_in_minutes: 1,
      },
    );

    // Force expiry by editing the metadata directly. Fake timers are risky
    // here because the MCP transport uses real microtasks and can hang.
    const row = store.storage.getObservation(handoff_observation_id);
    const meta = JSON.parse(row?.metadata ?? '{}') as { expires_at: number };
    meta.expires_at = Date.now() - 1000;
    store.storage.updateObservationMetadata(handoff_observation_id, JSON.stringify(meta));

    const error = await callError('task_accept_handoff', {
      handoff_observation_id,
      session_id: sessionB,
    });
    expect(error.code).toBe(TASK_THREAD_ERROR_CODES.HANDOFF_EXPIRED);

    // Metadata must flip to `expired` so the sender sees the outcome on
    // their next turn — staying `pending` after a failed accept would
    // let the handoff look live forever.
    const after = store.storage.getObservation(handoff_observation_id);
    const afterMeta = JSON.parse(after?.metadata ?? '{}');
    expect(afterMeta.status).toBe('expired');
  });

  it('rejects decline after the handoff has expired', async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();

    const { handoff_observation_id } = await call<{ handoff_observation_id: number }>(
      'task_hand_off',
      {
        task_id,
        session_id: sessionA,
        agent: 'claude',
        to_agent: 'codex',
        summary: 'too old to decline',
        expires_in_minutes: 1,
      },
    );

    const row = store.storage.getObservation(handoff_observation_id);
    const meta = JSON.parse(row?.metadata ?? '{}') as { expires_at: number };
    meta.expires_at = Date.now() - 1000;
    store.storage.updateObservationMetadata(handoff_observation_id, JSON.stringify(meta));

    const error = await callError('task_decline_handoff', {
      handoff_observation_id,
      session_id: sessionB,
      reason: 'too late',
    });
    expect(error.code).toBe(TASK_THREAD_ERROR_CODES.HANDOFF_EXPIRED);

    const after = store.storage.getObservation(handoff_observation_id);
    const afterMeta = JSON.parse(after?.metadata ?? '{}');
    expect(afterMeta.status).toBe('expired');
  });

  it("task_updates_since filters out the caller's own posts", async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();
    const cursor = Date.now() - 1; // strictly before either post

    await call('task_post', {
      task_id,
      session_id: sessionA,
      kind: 'note',
      content: 'from A',
    });
    await call('task_post', {
      task_id,
      session_id: sessionB,
      kind: 'blocker',
      content: 'from B',
    });

    const updatesForA = await call<Array<{ session_id: string }>>('task_updates_since', {
      task_id,
      session_id: sessionA,
      since_ts: cursor,
    });
    expect(updatesForA.every((row) => row.session_id !== sessionA)).toBe(true);
    expect(updatesForA.some((row) => row.session_id === sessionB)).toBe(true);

    // Symmetry — would silently break if someone swapped the filter.
    const updatesForB = await call<Array<{ session_id: string }>>('task_updates_since', {
      task_id,
      session_id: sessionB,
      since_ts: cursor,
    });
    expect(updatesForB.every((row) => row.session_id !== sessionB)).toBe(true);
    expect(updatesForB.some((row) => row.session_id === sessionA)).toBe(true);
  });

  it('task_post notes with a known task_id stay searchable without a duplicate notepad', async () => {
    const repoRoot = join(dir, 'repo-task-post-note');
    const { task_id, sessionA } = seedTwoSessionTask(repoRoot);

    const { id } = await call<{ id: number }>('task_post', {
      task_id,
      session_id: sessionA,
      kind: 'note',
      content:
        'write working note: save current state; remember progress; log what I am doing before verification',
    });

    const row = store.storage.getObservation(id);
    expect(row).toMatchObject({
      id,
      session_id: sessionA,
      task_id,
      kind: 'note',
      compressed: 1,
    });

    const taskTimeline = await call<Array<{ id: number }>>('task_timeline', { task_id });
    expect(taskTimeline.some((entry) => entry.id === id)).toBe(true);

    const sessionTimeline = store.timeline(sessionA, undefined, 10);
    expect(sessionTimeline.some((entry) => entry.id === id)).toBe(true);

    const hits = await store.search('save current state', 10);
    expect(hits.some((hit) => hit.id === id)).toBe(true);
    expect(existsSync(join(repoRoot, '.omx', 'notepad.md'))).toBe(false);
  });

  it('task_post hints when a post looks like directed agent coordination', async () => {
    const { task_id, sessionA } = seedTwoSessionTask();

    const { id, hint } = await call<{ id: number; hint?: string }>('task_post', {
      task_id,
      session_id: sessionA,
      kind: 'question',
      content: '@codex can you reply with the current blocker?',
    });

    expect(hint).toBe(
      'For directed agent coordination or posts that need a reply, use task_message. If you do not know task_id, use task_note_working.',
    );
    const row = store.storage.getObservation(id);
    expect(row).toMatchObject({
      id,
      session_id: sessionA,
      task_id,
      kind: 'question',
    });
  });

  it('task_post hints for directed agent action requests without blocking the post', async () => {
    const { task_id, sessionA } = seedTwoSessionTask();

    const { id, hint } = await call<{ id: number; hint?: string }>('task_post', {
      task_id,
      session_id: sessionA,
      kind: 'note',
      content: 'agent-15 please inspect the inbox routing before release.',
    });

    expect(hint).toBe(
      'For directed agent coordination or posts that need a reply, use task_message. If you do not know task_id, use task_note_working.',
    );
    expect(store.storage.getObservation(id)).toMatchObject({
      id,
      kind: 'note',
      content: 'agent-15 inspect inbox routing before release.',
      compressed: 1,
    });
  });

  it('task_post keeps shared agent mentions on task_post without a task_message hint', async () => {
    const { task_id, sessionA } = seedTwoSessionTask();

    const { hint } = await call<{ id: number; hint?: string }>('task_post', {
      task_id,
      session_id: sessionA,
      kind: 'note',
      content: 'agent-18 recorded shared verification evidence for the task thread',
    });

    expect(hint).toBe('If you do not know task_id, use task_note_working.');
  });

  it('task_post hints for action requests even without an agent mention', async () => {
    const { task_id, sessionA } = seedTwoSessionTask();

    const { hint } = await call<{ id: number; hint?: string }>('task_post', {
      task_id,
      session_id: sessionA,
      kind: 'question',
      content: 'Can you verify the directed message path?',
    });

    expect(hint).toBe(
      'For directed agent coordination or posts that need a reply, use task_message. If you do not know task_id, use task_note_working.',
    );
  });

  it('task_post keeps shared task notes on task_post without a task_message hint', async () => {
    const { task_id, sessionA } = seedTwoSessionTask();

    const { id, hint } = await call<{ id: number; hint?: string }>('task_post', {
      task_id,
      session_id: sessionA,
      kind: 'note',
      content:
        'branch=agent/demo; task=shared coordination state; blocker=none; next=none; evidence=pnpm test',
    });

    expect(hint).toBe('If you do not know task_id, use task_note_working.');
    expect(store.storage.getObservation(id)).toMatchObject({
      id,
      kind: 'note',
      content:
        'branch=agent/demo; task=shared coordination state; blocker=none; next=none; evidence=pnpm test',
    });
  });

  it('task_post nudges future-work notes toward task_propose', async () => {
    const { task_id, sessionA } = seedTwoSessionTask();

    const result = await call<{
      id: number;
      recommendation?: {
        tool: string;
        message: string;
        suggested_fields: { summary: string; rationale: string; touches_files: string[] };
      };
    }>('task_post', {
      task_id,
      session_id: sessionA,
      kind: 'decision',
      content:
        'Future work: add a health-card drilldown in `apps/cli/src/commands/health.ts` for pending proposal promotions after this patch.',
    });

    expect(result.id).toEqual(expect.any(Number));
    expect(result.recommendation).toMatchObject({
      tool: 'task_propose',
      suggested_fields: {
        summary: expect.stringContaining('health-card drilldown'),
        rationale: expect.stringContaining('Future work'),
        touches_files: ['apps/cli/src/commands/health.ts'],
      },
    });
    expect(result.recommendation?.message).toContain('foraging');
    expect(result.recommendation?.message).toContain('reinforce and promote');
  });

  it('task_post recommends task_propose for work explicitly not in this PR', async () => {
    const { task_id, sessionA } = seedTwoSessionTask();

    const result = await call<{
      id: number;
      recommendation?: {
        tool: string;
        suggested_fields: { summary: string; rationale: string; touches_files: string[] };
      };
    }>('task_post', {
      task_id,
      session_id: sessionA,
      kind: 'note',
      content:
        'Not in this PR: add proposal stale-state coverage in apps/mcp-server/test/task-threads.test.ts.',
    });

    expect(result.recommendation).toMatchObject({
      tool: 'task_propose',
      suggested_fields: {
        summary: expect.stringContaining('proposal stale-state coverage'),
        rationale: expect.stringContaining('Not in this PR'),
        touches_files: ['apps/mcp-server/test/task-threads.test.ts'],
      },
    });
  });

  it('task_post leaves ordinary notes quiet', async () => {
    const { task_id, sessionA } = seedTwoSessionTask();

    const result = await call<{ id: number; recommendation?: string }>('task_post', {
      task_id,
      session_id: sessionA,
      kind: 'note',
      content: 'State saved: context checked and tests are running.',
    });

    expect(result.id).toEqual(expect.any(Number));
    expect(result.recommendation).toBeUndefined();
  });

  it('task_note_working posts a note to the only active task for the session', async () => {
    const repoRoot = join(dir, 'repo-working-note-success');
    const { task_id, sessionA } = seedTwoSessionTask(repoRoot);

    const {
      observation_id,
      task_id: resolvedTaskId,
      omx_notepad_pointer,
    } = await call<{
      observation_id: number;
      task_id: number;
      omx_notepad_pointer: { status: string; reason: string };
    }>('task_note_working', {
      session_id: sessionA,
      repo_root: repoRoot,
      branch: 'feat/handoff',
      content: 'working state: tests are green, unique-working-note-token before push',
    });

    expect(resolvedTaskId).toBe(task_id);
    const row = store.storage.getObservation(observation_id);
    expect(row).toMatchObject({
      id: observation_id,
      session_id: sessionA,
      task_id,
      kind: 'note',
      compressed: 1,
    });
    const meta = JSON.parse(row?.metadata ?? '{}');
    expect(meta).toMatchObject({
      kind: 'note',
      working_note: true,
      resolved_by: 'task_note_working',
    });

    const hits = await store.search('unique-working-note-token', 10);
    expect(hits.some((hit) => hit.id === observation_id)).toBe(true);
    expect(omx_notepad_pointer).toMatchObject({
      status: 'skipped',
      reason: 'bridge.writeOmxNotepadPointer=false',
    });
    expect(existsSync(join(repoRoot, '.omx', 'notepad.md'))).toBe(false);
  });

  it('task_note_working writes a tiny OMX pointer when configured', async () => {
    const repoRoot = join(dir, 'repo-pointer');
    const original = defaultSettings.bridge.writeOmxNotepadPointer;
    defaultSettings.bridge.writeOmxNotepadPointer = true;
    try {
      const { task_id, sessionA } = seedTwoSessionTask(repoRoot);
      const longEvidence = `${'very long log line '.repeat(30)}SECRET_TAIL_SHOULD_NOT_APPEAR`;

      const { observation_id, omx_notepad_pointer } = await call<{
        observation_id: number;
        omx_notepad_pointer: { status: string; path: string };
      }>('task_note_working', {
        session_id: sessionA,
        repo_root: repoRoot,
        branch: 'feat/handoff',
        content: 'working state: SHOULD_NOT_APPEAR_IN_OMX_POINTER',
        pointer: {
          branch: 'agent/codex/working-note-bridge',
          task: 'bridge working notes',
          blocker: 'none',
          next: 'run focused tests',
          evidence: longEvidence,
        },
      });

      expect(store.storage.getObservation(observation_id)?.task_id).toBe(task_id);
      expect(omx_notepad_pointer.status).toBe('written');
      const note = readFileSync(join(repoRoot, '.omx', 'notepad.md'), 'utf8');
      expect(note).toContain('branch=agent/codex/working-note-bridge');
      expect(note).toContain('task=bridge working notes');
      expect(note).toContain('blocker=none');
      expect(note).toContain('next=run focused tests');
      expect(note).toContain('evidence=very long log line');
      expect(note).toContain(`colony_observation_id=${observation_id}`);
      expect(note).not.toContain('SHOULD_NOT_APPEAR_IN_OMX_POINTER');
      expect(note).not.toContain('SECRET_TAIL_SHOULD_NOT_APPEAR');
      const evidence = note.match(/evidence=([^;]+)/)?.[1] ?? '';
      expect(evidence.length).toBeLessThanOrEqual(180);
    } finally {
      defaultSettings.bridge.writeOmxNotepadPointer = original;
    }
  });

  it('task_note_working resolves by repo_root and branch when the session has multiple tasks', async () => {
    const { task_id, sessionA } = seedTwoSessionTask();
    const other = TaskThread.open(store, {
      repo_root: '/repo',
      branch: 'feat/other',
      session_id: sessionA,
    });
    other.join(sessionA, 'claude');

    const { observation_id, task_id: resolvedTaskId } = await call<{
      observation_id: number;
      task_id: number;
    }>('task_note_working', {
      session_id: sessionA,
      repo_root: '/repo',
      branch: 'feat/handoff',
      content: 'working state: stay on the handoff branch',
    });

    expect(resolvedTaskId).toBe(task_id);
    expect(store.storage.getObservation(observation_id)?.task_id).toBe(task_id);
  });

  it('task_note_working returns compact candidates when active task resolution is ambiguous', async () => {
    const repoRoot = join(dir, 'repo-ambiguous');
    const { task_id, sessionA } = seedTwoSessionTask(repoRoot);
    const other = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'feat/other',
      session_id: sessionA,
    });
    other.join(sessionA, 'claude');

    const err = await callError<{
      code: string;
      error: string;
      candidates: Array<{ task_id: number; repo_root: string; branch: string; agent: string }>;
    }>('task_note_working', {
      session_id: sessionA,
      repo_root: repoRoot,
      content: 'working state: should not be guessed',
      allow_omx_notepad_fallback: true,
      pointer: {
        branch: 'agent/codex/ambiguous',
        task: 'ambiguous working note',
        blocker: 'needs task selection',
        next: 'choose task_id',
        evidence: 'none',
      },
    });

    expect(err.code).toBe('AMBIGUOUS_ACTIVE_TASK');
    expect(err.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ task_id, repo_root: repoRoot, branch: 'feat/handoff' }),
        expect.objectContaining({
          task_id: other.task_id,
          repo_root: repoRoot,
          branch: 'feat/other',
        }),
      ]),
    );
    expect(store.storage.taskTimeline(task_id).some((row) => row.content.includes('guessed'))).toBe(
      false,
    );
    expect(
      store.storage.taskTimeline(other.task_id).some((row) => row.content.includes('guessed')),
    ).toBe(false);
    expect(existsSync(join(repoRoot, '.omx', 'notepad.md'))).toBe(false);
  });

  it('task_note_working can fall back to a tiny OMX pointer when no active task matches', async () => {
    const repoRoot = join(dir, 'repo-no-active-task');

    const result = await call<{
      status: string;
      observation_id: null;
      task_id: null;
      omx_notepad_pointer: { status: string; path: string };
    }>('task_note_working', {
      session_id: 'missing-session',
      repo_root: repoRoot,
      content: 'working state: SHOULD_NOT_APPEAR_IN_OMX_FALLBACK',
      allow_omx_notepad_fallback: true,
      pointer: {
        branch: 'agent/codex/no-active-task',
        task: 'no active Colony task',
        blocker: 'ACTIVE_TASK_NOT_FOUND',
        next: 'open or join a Colony task',
        evidence: 'task_note_working',
      },
    });

    expect(result).toMatchObject({
      status: 'omx_notepad_fallback',
      observation_id: null,
      task_id: null,
      omx_notepad_pointer: { status: 'written' },
    });
    const note = readFileSync(join(repoRoot, '.omx', 'notepad.md'), 'utf8');
    expect(note).toContain('branch=agent/codex/no-active-task');
    expect(note).toContain('blocker=ACTIVE_TASK_NOT_FOUND');
    expect(note).toContain('colony_observation_id=unavailable');
    expect(note).not.toContain('SHOULD_NOT_APPEAR_IN_OMX_FALLBACK');
  });

  it('task_note_working materializes a task when repo_root and branch are supplied', async () => {
    const repoRoot = join(dir, 'repo-materialized-task');
    const seeded = seedTwoSessionTask(repoRoot);

    const result = await call<{
      observation_id: number;
      task_id: number;
      status: string;
    }>('task_note_working', {
      session_id: 'fresh-unjoined-session',
      repo_root: repoRoot,
      branch: 'feat/handoff',
      content: 'working state: materialized instead of ACTIVE_TASK_NOT_FOUND',
    });

    expect(result).toMatchObject({
      task_id: seeded.task_id,
      status: 'task_materialized',
    });
    expect(store.storage.listParticipants(seeded.task_id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ session_id: 'fresh-unjoined-session', agent: 'unknown' }),
      ]),
    );
    expect(store.storage.getObservation(result.observation_id)).toMatchObject({
      task_id: seeded.task_id,
      kind: 'note',
    });
  });

  it('task_note_working creates a branch task instead of failing when no task row exists', async () => {
    const repoRoot = join(dir, 'repo-materialized-new-task');

    const result = await call<{
      observation_id: number;
      task_id: number;
      status: string;
    }>('task_note_working', {
      session_id: 'fresh-new-branch-session',
      repo_root: repoRoot,
      branch: 'agent/codex/new-working-note-task',
      content: 'working state: created task instead of ACTIVE_TASK_NOT_FOUND',
    });

    expect(result.status).toBe('task_materialized');
    expect(store.storage.getTask(result.task_id)).toMatchObject({
      repo_root: repoRoot,
      branch: 'agent/codex/new-working-note-task',
    });
    expect(store.storage.getObservation(result.observation_id)).toMatchObject({
      task_id: result.task_id,
      kind: 'note',
    });
  });

  it('task_list includes a ready-queue warning and next tool', async () => {
    const { sessionA } = seedTwoSessionTask();

    const first = await call<{
      hint: string;
      coordination_warning: string;
      next_tool: string;
      tasks: unknown[];
    }>('task_list', {
      session_id: sessionA,
    });
    expect(first.tasks).toHaveLength(1);
    expect(first.hint).toBe(
      'Use task_ready_for_agent to choose claimable work; task_list is for browsing.',
    );
    expect(first.coordination_warning).toBe(
      'task_list is inventory; use task_ready_for_agent to choose work.',
    );
    expect(first.next_tool).toBe('task_ready_for_agent');
  });

  it('task_list returns a compact rollup by default and a full shape via detail:"full"', async () => {
    const { sessionA } = seedTwoSessionTask();

    const compact = await call<{ tasks: Array<Record<string, unknown>> }>('task_list', {
      session_id: sessionA,
    });
    const full = await call<{ tasks: Array<Record<string, unknown>> }>('task_list', {
      session_id: sessionA,
      detail: 'full',
    });

    expect(compact.tasks).toHaveLength(1);
    const compactRow = compact.tasks[0] as Record<string, unknown>;
    expect(Object.keys(compactRow).sort()).toEqual(
      ['branch', 'id', 'status', 'title', 'updated_at'].sort(),
    );
    expect(compactRow).not.toHaveProperty('repo_root');
    expect(compactRow).not.toHaveProperty('created_by');
    expect(compactRow).not.toHaveProperty('created_at');

    const fullRow = full.tasks[0] as Record<string, unknown>;
    expect(fullRow).toHaveProperty('repo_root');
    expect(fullRow).toHaveProperty('created_by');
    expect(fullRow).toHaveProperty('created_at');
    expect(JSON.stringify(compact.tasks).length).toBeLessThan(JSON.stringify(full.tasks).length);
  });

  it('task_list strengthens the warning after repeated inventory reads', async () => {
    const { sessionA } = seedTwoSessionTask();

    store.addObservation({
      session_id: sessionA,
      kind: 'tool_use',
      content: 'task_list',
      metadata: { tool: 'mcp__colony__task_list' },
    });

    const repeated = await call<{
      hint: string;
      coordination_warning: string;
      next_tool: string;
    }>('task_list', { session_id: sessionA });
    expect(repeated.hint).toBe('task_list is inventory; use task_ready_for_agent to choose work.');
    expect(repeated.coordination_warning).toBe(
      'Stop browsing. Call task_ready_for_agent before selecting work.',
    );
    expect(repeated.next_tool).toBe('task_ready_for_agent');

    store.addObservation({
      session_id: sessionA,
      kind: 'tool_use',
      content: 'task_ready_for_agent',
      metadata: { tool: 'mcp__colony__task_ready_for_agent' },
    });

    const afterReady = await call<{ hint: string; coordination_warning?: string }>('task_list', {
      session_id: sessionA,
    });
    expect(afterReady.hint).toBe(
      'Use task_ready_for_agent to choose claimable work; task_list is for browsing.',
    );
    expect(afterReady.coordination_warning).toBeUndefined();
  });

  it('task_post stores negative warning kinds and search returns them compactly', async () => {
    const { task_id, sessionA } = seedTwoSessionTask();

    const { id } = await call<{ id: number }>('task_post', {
      task_id,
      session_id: sessionA,
      kind: 'failed_approach',
      content:
        'Failed approach: do not repeat naive mutex route in src/router.ts; it deadlocked retries.',
    });

    const row = store.storage.getObservation(id);
    expect(row).toMatchObject({
      id,
      session_id: sessionA,
      task_id,
      kind: 'failed_approach',
    });

    const hits = await call<Array<{ id: number; kind: string; task_id: number | null }>>('search', {
      query: 'do not repeat naive mutex route',
      limit: 5,
    });
    expect(hits).toContainEqual(expect.objectContaining({ id, kind: 'failed_approach', task_id }));
  });

  // Relay lifecycle. Different from handoff: relays assume the sender is
  // gone, so claims become handoff_pending at emit time and are re-claimed by
  // the receiver on accept (no competing strong claim is left in the gap). The
  // sender provides only `reason` + `one_line` + `base_branch`; the rest
  // is auto-synthesized from the task thread so a Stop / SessionEnd hook
  // firing seconds before the process dies still produces a usable
  // packet. These tests exercise that contract through the MCP surface.

  it('task_relay weakens sender claims at emit and task_accept_relay re-claims them on the receiver', async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();

    await call('task_claim_file', {
      task_id,
      session_id: sessionA,
      file_path: 'src/auth.ts',
    });
    const { relay_observation_id } = await call<{ relay_observation_id: number; status: string }>(
      'task_relay',
      {
        task_id,
        session_id: sessionA,
        agent: 'claude',
        reason: 'quota',
        one_line: 'halfway through replacing auth middleware',
        base_branch: 'main',
      },
    );

    expect(store.storage.getClaim(task_id, 'src/auth.ts')).toMatchObject({
      session_id: sessionA,
      state: 'handoff_pending',
      handoff_observation_id: relay_observation_id,
    });

    // worktree_recipe.inherit_claims captures the weakened claims so the
    // receiver knows what to re-claim. Read the metadata directly because
    // the MCP surface deliberately doesn't expose it on the emit response.
    const row = store.storage.getObservation(relay_observation_id);
    const meta = JSON.parse(row?.metadata ?? '{}') as {
      worktree_recipe: { inherit_claims: string[]; fetch_files_at: string | null };
    };
    expect(meta.worktree_recipe.inherit_claims).toEqual(['src/auth.ts']);
    expect(meta.worktree_recipe.fetch_files_at).toBeNull();

    const accepted = await call<{ status: string }>('task_accept_relay', {
      relay_observation_id,
      session_id: sessionB,
    });
    expect(accepted.status).toBe('accepted');

    expect(store.storage.getClaim(task_id, 'src/auth.ts')).toMatchObject({
      session_id: sessionB,
      state: 'active',
      expires_at: null,
      handoff_observation_id: null,
    });

    // Second accept must fail — already accepted.
    const retry = await callError('task_accept_relay', {
      relay_observation_id,
      session_id: sessionB,
    });
    expect(retry.code).toBe(TASK_THREAD_ERROR_CODES.ALREADY_ACCEPTED);
  });

  it('task_claim_quota_accept transfers quota-pending claims and marks the relay accepted', async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();

    await call('task_claim_file', {
      task_id,
      session_id: sessionA,
      file_path: 'src/auth.ts',
    });
    await call('task_claim_file', {
      task_id,
      session_id: sessionA,
      file_path: 'src/api.ts',
    });

    const { relay_observation_id } = await call<{ relay_observation_id: number }>('task_relay', {
      task_id,
      session_id: sessionA,
      agent: 'claude',
      reason: 'quota',
      one_line: 'finish auth middleware',
      base_branch: 'main',
    });

    const accepted = await call<{
      status: string;
      accepted_files: string[];
      audit_observation_id: number;
    }>('task_claim_quota_accept', {
      task_id,
      session_id: sessionB,
      file_path: 'src/auth.ts',
    });

    expect(accepted).toMatchObject({
      status: 'accepted',
    });
    expect(accepted.accepted_files).toEqual(expect.arrayContaining(['src/auth.ts', 'src/api.ts']));
    expect(accepted.accepted_files).toHaveLength(2);
    expect(store.storage.getClaim(task_id, 'src/auth.ts')).toMatchObject({
      session_id: sessionB,
      state: 'active',
      expires_at: null,
      handoff_observation_id: null,
    });
    expect(store.storage.getClaim(task_id, 'src/api.ts')).toMatchObject({
      session_id: sessionB,
      state: 'active',
      expires_at: null,
      handoff_observation_id: null,
    });
    const relay = store.storage.getObservation(relay_observation_id);
    const relayMeta = JSON.parse(relay?.metadata ?? '{}');
    expect(relayMeta.status).toBe('accepted');
    expect(relayMeta.accepted_by_session_id).toBe(sessionB);
    expect(store.storage.getObservation(accepted.audit_observation_id)).toMatchObject({
      kind: 'note',
      reply_to: relay_observation_id,
    });
  });

  it('task_claim_quota_decline records a reason without cancelling the relay', async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();
    store.startSession({ id: 'C', ide: 'gemini', cwd: '/repo' });
    const thread = TaskThread.open(store, {
      repo_root: '/repo',
      branch: 'feat/handoff',
      session_id: 'C',
    });
    thread.join('C', 'gemini');

    await call('task_claim_file', {
      task_id,
      session_id: sessionA,
      file_path: 'src/auth.ts',
    });
    const { relay_observation_id } = await call<{ relay_observation_id: number }>('task_relay', {
      task_id,
      session_id: sessionA,
      agent: 'claude',
      reason: 'quota',
      one_line: 'needs replacement owner',
      base_branch: 'main',
      to_session_id: sessionB,
    });

    const declined = await call<{ status: string; still_visible: boolean }>(
      'task_claim_quota_decline',
      {
        task_id,
        session_id: sessionB,
        file_path: 'src/auth.ts',
        reason: 'not enough context left',
      },
    );

    expect(declined).toMatchObject({ status: 'declined', still_visible: true });
    expect(store.storage.getClaim(task_id, 'src/auth.ts')).toMatchObject({
      session_id: sessionA,
      state: 'handoff_pending',
      handoff_observation_id: relay_observation_id,
    });
    const relay = store.storage.getObservation(relay_observation_id);
    const relayMeta = JSON.parse(relay?.metadata ?? '{}');
    expect(relayMeta).toMatchObject({
      status: 'pending',
      to_agent: 'any',
      to_session_id: null,
      quota_claim_declines: [
        expect.objectContaining({ session_id: sessionB, reason: 'not enough context left' }),
      ],
    });
    expect(new TaskThread(store, task_id).pendingRelaysFor('C', 'gemini').map((r) => r.id)).toEqual(
      [relay_observation_id],
    );
  });

  it('task_claim_quota_release_expired downgrades expired quota claims to weak_expired', async () => {
    const t0 = Date.parse('2026-05-01T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();

    await call('task_claim_file', {
      task_id,
      session_id: sessionA,
      file_path: 'src/auth.ts',
    });
    const { relay_observation_id } = await call<{ relay_observation_id: number }>('task_relay', {
      task_id,
      session_id: sessionA,
      agent: 'claude',
      reason: 'quota',
      one_line: 'expired cleanup',
      base_branch: 'main',
      expires_in_minutes: 1,
    });

    vi.setSystemTime(t0 + 2 * 60_000);
    const released = await call<{
      status: string;
      released_claims: Array<{ file_path: string; state: string }>;
    }>('task_claim_quota_release_expired', {
      task_id,
      session_id: sessionB,
      file_path: 'src/auth.ts',
    });

    expect(released).toMatchObject({
      status: 'released_expired',
      released_claims: [{ file_path: 'src/auth.ts', state: 'weak_expired' }],
    });
    expect(store.storage.getClaim(task_id, 'src/auth.ts')).toMatchObject({
      session_id: sessionA,
      state: 'weak_expired',
      handoff_observation_id: relay_observation_id,
    });
    const reflexions = store.storage.taskObservationsByKind(task_id, 'reflexion', 10);
    expect(reflexions).toHaveLength(1);
    expect(JSON.parse(reflexions[0]?.metadata ?? '{}')).toMatchObject({
      kind: 'rollback',
      reward: -0.25,
      source_kind: 'claim-weakened',
      idempotency_key: `quota-release:${task_id}:src/auth.ts:${sessionA}:${relay_observation_id}`,
    });
    const relay = store.storage.getObservation(relay_observation_id);
    const relayMeta = JSON.parse(relay?.metadata ?? '{}');
    expect(relayMeta.status).toBe('expired');
  });

  it('task_claim_quota_release_expired downgrades every expired claim on a relay baton', async () => {
    const t0 = Date.parse('2026-05-01T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();

    await call('task_claim_file', {
      task_id,
      session_id: sessionA,
      file_path: 'src/auth.ts',
    });
    await call('task_claim_file', {
      task_id,
      session_id: sessionA,
      file_path: 'src/api.ts',
    });
    const { relay_observation_id } = await call<{ relay_observation_id: number }>('task_relay', {
      task_id,
      session_id: sessionA,
      agent: 'claude',
      reason: 'quota',
      one_line: 'expired multi-file cleanup',
      base_branch: 'main',
      expires_in_minutes: 1,
    });

    vi.setSystemTime(t0 + 2 * 60_000);
    const released = await call<{
      status: string;
      released_claims: Array<{ file_path: string; state: string }>;
      audit_observation_ids: number[];
    }>('task_claim_quota_release_expired', {
      task_id,
      session_id: sessionB,
      handoff_observation_id: relay_observation_id,
    });

    expect(released.status).toBe('released_expired');
    expect(released.released_claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file_path: 'src/auth.ts', state: 'weak_expired' }),
        expect.objectContaining({ file_path: 'src/api.ts', state: 'weak_expired' }),
      ]),
    );
    expect(released.released_claims).toHaveLength(2);
    expect(released.audit_observation_ids).toHaveLength(2);
    expect(store.storage.getClaim(task_id, 'src/auth.ts')).toMatchObject({
      session_id: sessionA,
      state: 'weak_expired',
      expires_at: t0 + 60_000,
      handoff_observation_id: relay_observation_id,
    });
    expect(store.storage.getClaim(task_id, 'src/api.ts')).toMatchObject({
      session_id: sessionA,
      state: 'weak_expired',
      expires_at: t0 + 60_000,
      handoff_observation_id: relay_observation_id,
    });
    const relay = store.storage.getObservation(relay_observation_id);
    const relayMeta = JSON.parse(relay?.metadata ?? '{}');
    expect(relayMeta.status).toBe('expired');
  });

  it('task_claim_quota_accept rejects already accepted quota relays', async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();

    await call('task_claim_file', {
      task_id,
      session_id: sessionA,
      file_path: 'src/auth.ts',
    });
    const { relay_observation_id } = await call<{ relay_observation_id: number }>('task_relay', {
      task_id,
      session_id: sessionA,
      agent: 'claude',
      reason: 'quota',
      one_line: 'accept once',
      base_branch: 'main',
    });

    await call('task_claim_quota_accept', {
      task_id,
      session_id: sessionB,
      handoff_observation_id: relay_observation_id,
    });
    const retry = await callError('task_claim_quota_accept', {
      task_id,
      session_id: sessionB,
      handoff_observation_id: relay_observation_id,
    });
    expect(retry.code).toBe(TASK_THREAD_ERROR_CODES.ALREADY_ACCEPTED);
  });

  it('task_claim_quota_accept reports missing tasks', async () => {
    const missing = await callError('task_claim_quota_accept', {
      task_id: 999_999,
      session_id: 'missing',
      file_path: 'src/missing.ts',
    });
    expect(missing.code).toBe(TASK_THREAD_ERROR_CODES.TASK_NOT_FOUND);
  });

  it('task_claim_quota_accept rejects wrong targets and mismatched baton ids', async () => {
    const { task_id, sessionA } = seedTwoSessionTask();
    store.startSession({ id: 'C', ide: 'gemini', cwd: '/repo' });
    const thread = TaskThread.open(store, {
      repo_root: '/repo',
      branch: 'feat/handoff',
      session_id: 'C',
    });
    thread.join('C', 'gemini');

    await call('task_claim_file', {
      task_id,
      session_id: sessionA,
      file_path: 'src/auth.ts',
    });
    await call<{ relay_observation_id: number }>('task_relay', {
      task_id,
      session_id: sessionA,
      agent: 'claude',
      reason: 'quota',
      one_line: 'codex only',
      base_branch: 'main',
      to_agent: 'codex',
    });

    const refused = await callError('task_claim_quota_accept', {
      task_id,
      session_id: 'C',
      file_path: 'src/auth.ts',
    });
    expect(refused.code).toBe(TASK_THREAD_ERROR_CODES.NOT_TARGET_AGENT);

    const { id: noteId } = await call<{ id: number }>('task_post', {
      task_id,
      session_id: sessionA,
      kind: 'note',
      content: 'not the relay',
    });
    const conflict = await callError('task_claim_quota_accept', {
      task_id,
      session_id: 'C',
      file_path: 'src/auth.ts',
      handoff_observation_id: noteId,
    });
    expect(conflict.code).toBe(TASK_THREAD_ERROR_CODES.CLAIM_BATON_CONFLICT);
  });

  it('task_decline_relay cancels a pending relay and prevents subsequent accept', async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();

    const { relay_observation_id } = await call<{ relay_observation_id: number }>('task_relay', {
      task_id,
      session_id: sessionA,
      agent: 'claude',
      reason: 'manual',
      one_line: 'try someone else',
      base_branch: 'main',
    });

    await call('task_decline_relay', {
      relay_observation_id,
      session_id: sessionB,
      reason: 'mid-turn on another task',
    });

    const declined = store.storage.getObservation(relay_observation_id);
    const declinedMeta = JSON.parse(declined?.metadata ?? '{}') as { status: string };
    expect(declinedMeta.status).toBe('cancelled');

    // Decline must surface in the timeline so the sender's next turn
    // can render "B declined: <reason>" via the hook preface.
    const timeline = await call<Array<{ id: number; kind: string }>>('task_timeline', {
      task_id,
    });
    expect(timeline.some((r) => r.kind === 'decline')).toBe(true);

    const error = await callError('task_accept_relay', {
      relay_observation_id,
      session_id: sessionB,
    });
    expect(error.code).toBe(TASK_THREAD_ERROR_CODES.ALREADY_CANCELLED);
  });

  it('task_accept_relay refuses an agent the relay was not addressed to', async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();
    // Add a third participant whose agent is neither sender nor target.
    store.startSession({ id: 'C', ide: 'gemini', cwd: '/repo' });
    const thread = TaskThread.open(store, {
      repo_root: '/repo',
      branch: 'feat/handoff',
      session_id: 'C',
    });
    thread.join('C', 'gemini');

    const { relay_observation_id } = await call<{ relay_observation_id: number }>('task_relay', {
      task_id,
      session_id: sessionA,
      agent: 'claude',
      reason: 'quota',
      one_line: 'codex only',
      base_branch: 'main',
      to_agent: 'codex',
    });

    const refused = await callError('task_accept_relay', {
      relay_observation_id,
      session_id: 'C',
    });
    expect(refused.code).toBe(TASK_THREAD_ERROR_CODES.NOT_TARGET_AGENT);

    // The targeted session can still accept — proves the directed relay
    // wasn't accidentally invalidated by the wrong-agent attempt.
    const accepted = await call<{ status: string }>('task_accept_relay', {
      relay_observation_id,
      session_id: sessionB,
    });
    expect(accepted.status).toBe('accepted');
  });

  it('task_accept_relay rejects expired relays and flips status to expired', async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();

    const { relay_observation_id } = await call<{ relay_observation_id: number }>('task_relay', {
      task_id,
      session_id: sessionA,
      agent: 'claude',
      reason: 'turn-cap',
      one_line: 'stale by design',
      base_branch: 'main',
      expires_in_minutes: 1,
    });

    // Fake-timers would race the MCP transport, so force expiry by
    // back-dating the metadata directly — same shape as the existing
    // handoff-expiry test above.
    const before = store.storage.getObservation(relay_observation_id);
    const meta = JSON.parse(before?.metadata ?? '{}') as { expires_at: number };
    meta.expires_at = Date.now() - 1000;
    store.storage.updateObservationMetadata(relay_observation_id, JSON.stringify(meta));

    const error = await callError('task_accept_relay', {
      relay_observation_id,
      session_id: sessionB,
    });
    expect(error.code).toBe(TASK_THREAD_ERROR_CODES.RELAY_EXPIRED);

    // The acceptance attempt must persist the terminal `expired` status
    // so the relay doesn't keep advertising itself as `pending` to other
    // recipients after expiry.
    const after = store.storage.getObservation(relay_observation_id);
    const afterMeta = JSON.parse(after?.metadata ?? '{}');
    expect(afterMeta.status).toBe('expired');
  });
});

describe('task_claim_file — protected-branch guard', () => {
  // Isolated store + server with the guard enabled (default setting).
  // The module-level beforeEach uses rejectProtectedBranchClaims:false so the
  // existing fixtures keep working; this suite needs the default-on behavior.
  let guardedDir: string;
  let guardedStore: MemoryStore;
  let guardedClient: Client;

  beforeEach(async () => {
    guardedDir = mkdtempSync(join(tmpdir(), 'colony-protected-branch-'));
    const settings = { ...defaultSettings, rejectProtectedBranchClaims: true };
    guardedStore = new MemoryStore({ dbPath: join(guardedDir, 'data.db'), settings });
    const server = buildServer(guardedStore, settings);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    guardedClient = new Client({ name: 'test-guard', version: '0.0.0' });
    await Promise.all([server.connect(serverT), guardedClient.connect(clientT)]);
  });

  afterEach(async () => {
    await guardedClient.close();
    guardedStore.close();
    rmSync(guardedDir, { recursive: true, force: true });
  });

  it('rejects task_claim_file with PROTECTED_BRANCH_CLAIM_REJECTED when task branch is main', async () => {
    guardedStore.startSession({ id: 'S1', ide: 'claude-code', cwd: '/repo' });
    const thread = TaskThread.open(guardedStore, {
      repo_root: '/repo',
      branch: 'main',
      session_id: 'S1',
    });
    const res = await guardedClient.callTool({
      name: 'task_claim_file',
      arguments: { task_id: thread.task_id, session_id: 'S1', file_path: '/repo/src/index.ts' },
    });
    expect(res.isError).toBe(true);
    const body = JSON.parse(
      (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}',
    );
    expect(body.code).toBe(TASK_THREAD_ERROR_CODES.PROTECTED_BRANCH_CLAIM_REJECTED);
    // No claim row written.
    expect(guardedStore.storage.getClaim(thread.task_id, '/repo/src/index.ts')).toBeFalsy();
  });

  it('allows task_claim_file when task branch is an agent/* branch', async () => {
    guardedStore.startSession({ id: 'S2', ide: 'claude-code', cwd: '/repo' });
    const thread = TaskThread.open(guardedStore, {
      repo_root: '/repo',
      branch: 'agent/claude/my-fix',
      session_id: 'S2',
    });
    const res = await guardedClient.callTool({
      name: 'task_claim_file',
      arguments: { task_id: thread.task_id, session_id: 'S2', file_path: '/repo/src/index.ts' },
    });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(
      (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}',
    );
    expect(body.claim_status).toBe('claimed');
  });
});
