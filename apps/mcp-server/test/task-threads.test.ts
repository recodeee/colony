import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  const server = buildServer(store, defaultSettings);
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
      'For directed agent coordination, use task_message. If you do not know task_id, use task_note_working.',
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
      'For directed agent coordination, use task_message. If you do not know task_id, use task_note_working.',
    );
    expect(store.storage.getObservation(id)).toMatchObject({
      id,
      kind: 'note',
      content: 'agent-15 inspect inbox routing before release.',
      compressed: 1,
    });
  });

  it('task_post hints to task_note_working for unknown task_id cases', async () => {
    const { task_id, sessionA } = seedTwoSessionTask();

    const { hint } = await call<{ id: number; hint?: string }>('task_post', {
      task_id,
      session_id: sessionA,
      kind: 'note',
      content: 'agent-18 recorded shared verification evidence for the task thread',
    });

    expect(hint).toBe('If you do not know task_id, use task_note_working.');
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
      branch: 'agent/codex/no-active-task',
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
      'task_list is inventory. Use task_ready_for_agent to choose claimable work.',
    );
    expect(first.next_tool).toBe('task_ready_for_agent');
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
    expect(repeated.hint).toBe(
      'task_list is inventory. Use task_ready_for_agent to choose claimable work.',
    );
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

    const afterReady = await call<{ hint: string; coordination_warning: string }>('task_list', {
      session_id: sessionA,
    });
    expect(afterReady.hint).toBe(
      'Use task_ready_for_agent to choose claimable work; task_list is for browsing.',
    );
    expect(afterReady.coordination_warning).toBe(
      'task_list is inventory. Use task_ready_for_agent to choose claimable work.',
    );
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
  // gone, so claims are *dropped* at emit time and re-claimed by the
  // receiver on accept (no third agent can grab a file in the gap). The
  // sender provides only `reason` + `one_line` + `base_branch`; the rest
  // is auto-synthesized from the task thread so a Stop / SessionEnd hook
  // firing seconds before the process dies still produces a usable
  // packet. These tests exercise that contract through the MCP surface.

  it('task_relay drops sender claims at emit and task_accept_relay re-claims them on the receiver', async () => {
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

    // Sender claims must be vacant between emit and accept — otherwise a
    // third agent racing in the gap could grab the file. This is the
    // load-bearing invariant that makes the primitive safe.
    expect(store.storage.getClaim(task_id, 'src/auth.ts')).toBeUndefined();

    // worktree_recipe.inherit_claims captures the dropped claims so the
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

    // Claim re-installed under B.
    expect(store.storage.getClaim(task_id, 'src/auth.ts')?.session_id).toBe(sessionB);

    // Second accept must fail — already accepted.
    const retry = await callError('task_accept_relay', {
      relay_observation_id,
      session_id: sessionB,
    });
    expect(retry.code).toBe(TASK_THREAD_ERROR_CODES.ALREADY_ACCEPTED);
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
