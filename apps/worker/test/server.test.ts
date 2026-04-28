import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { type DiscrepancyReport, MemoryStore, TaskThread } from '@colony/core';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/server.js';

let dir: string;
let store: MemoryStore;
let app: Hono;

interface TestDiscrepancyMetric {
  count: number;
  rate: number;
  denominator: number;
  examples: [];
  truncated: false;
}

type TestDiscrepancyReport = DiscrepancyReport & {
  edits_without_claims: TestDiscrepancyMetric;
  sessions_ended_without_handoff: TestDiscrepancyMetric;
  blockers_without_messages: TestDiscrepancyMetric;
  proposals_without_reinforcement: TestDiscrepancyMetric;
};

const discrepancyReportMockState = {
  buildDiscrepancyReport: vi.fn(),
  reportByStore: new WeakMap<object, unknown>(),
};

function seed(): { sessionId: string; a: number; b: number } {
  store.startSession({ id: 's1', ide: 'claude-code', cwd: '/tmp' });
  const a = store.addObservation({
    session_id: 's1',
    kind: 'note',
    content: 'The db config lives at /etc/caveman.conf.',
  });
  const b = store.addObservation({
    session_id: 's1',
    kind: 'note',
    content: 'Please run `pnpm test` now.',
  });
  return { sessionId: 's1', a, b };
}

function seedRuntime(repoRoot: string): void {
  const worktreePath = join(repoRoot, '.omx', 'agent-worktrees', 'agent__codex__viewer-task');
  const activeSessionDir = join(repoRoot, '.omx', 'state', 'active-sessions');
  const now = new Date().toISOString();
  mkdirSync(activeSessionDir, { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(
    join(activeSessionDir, 'agent__codex__viewer-task.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repoRoot,
        branch: 'agent/codex/viewer-task',
        taskName: 'Show Hivemind dashboard',
        latestTaskPreview: 'Render active lanes in worker viewer',
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
}

function seedFileLocks(repoRoot: string): void {
  const lockStateDir = join(repoRoot, '.omx', 'state');
  const now = new Date().toISOString();
  mkdirSync(lockStateDir, { recursive: true });
  writeFileSync(
    join(lockStateDir, 'agent-file-locks.json'),
    `${JSON.stringify(
      {
        locks: {
          'apps/worker/src/server.ts': {
            branch: 'agent/codex/viewer-locks',
            claimed_at: now,
            allow_delete: false,
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function seedStrandedSession(): { sessionId: string; lastError: string } {
  const now = Date.UTC(2026, 3, 28, 12, 0, 0);
  vi.setSystemTime(now);
  const sessionId = 'codex-stranded-session-abcdef';
  const lastActivity = now - 12 * 60_000;
  store.storage.createSession({
    id: sessionId,
    ide: 'codex',
    cwd: '/repo/colony',
    started_at: lastActivity - 1_000,
    metadata: null,
  });
  const task = store.storage.findOrCreateTask({
    title: 'plans stranded rescue surface',
    repo_root: '/repo/colony',
    branch: 'agent/codex/plans-stranded',
    created_by: sessionId,
  });
  store.storage.addTaskParticipant({ task_id: task.id, session_id: sessionId, agent: 'codex' });
  for (const filePath of [
    'apps/worker/src/viewer.ts',
    'apps/worker/src/server.ts',
    'apps/worker/test/server.test.ts',
    'packages/core/src/rescue.ts',
  ]) {
    store.storage.claimFile({ task_id: task.id, file_path: filePath, session_id: sessionId });
  }
  const lastError =
    'Error: permission denied while calling rescue_stranded_run for stranded session; extra diagnostic text after eighty characters';
  store.storage.insertObservation({
    session_id: sessionId,
    kind: 'tool_use',
    content: 'rescue failed',
    compressed: false,
    intensity: null,
    metadata: { error: lastError },
    task_id: task.id,
    ts: lastActivity,
  });
  return { sessionId, lastError };
}

function seedCoordinationEdits(counts: { unclaimed: number; claimed: number }): void {
  store.startSession({ id: 'coord-session', ide: 'codex', cwd: '/repo' });
  const task = store.storage.findOrCreateTask({
    title: 'coordination-task',
    repo_root: '/repo',
    branch: 'agent/codex/coordination-task',
    created_by: 'coord-session',
  });
  for (let i = 0; i < counts.unclaimed; i++) {
    store.addObservation({
      session_id: 'coord-session',
      kind: 'tool_use',
      content: `Edit src/orphan-${i}.ts`,
      task_id: task.id,
      metadata: { tool: 'Edit', file_path: `src/orphan-${i}.ts` },
    });
  }
  for (let i = 0; i < counts.claimed; i++) {
    const filePath = `src/claimed-${i}.ts`;
    store.addObservation({
      session_id: 'coord-session',
      kind: 'claim',
      content: `Claim ${filePath}`,
      task_id: task.id,
      metadata: { file_path: filePath },
    });
    store.addObservation({
      session_id: 'coord-session',
      kind: 'tool_use',
      content: `Edit ${filePath}`,
      task_id: task.id,
      metadata: { tool: 'Edit', file_path: filePath },
    });
  }
}

function setDiscrepancyReport(report: TestDiscrepancyReport): void {
  discrepancyReportMockState.reportByStore.set(store, report);
}

function buildMockDiscrepancyReport(
  sourceStore: MemoryStore,
  options: { since: number },
): TestDiscrepancyReport {
  const override = discrepancyReportMockState.reportByStore.get(sourceStore);
  if (override) return override as TestDiscrepancyReport;

  const totalEdits = sourceStore.storage
    .listSessions(1000)
    .flatMap((session) => sourceStore.timeline(session.id, undefined, 1000))
    .filter(
      (obs) =>
        obs.kind === 'tool_use' &&
        obs.ts > options.since &&
        typeof obs.metadata?.file_path === 'string',
    ).length;
  const editsWithoutClaims = sourceStore.storage.recentEditsWithoutClaims(
    options.since,
    1000,
  ).length;
  return {
    window: { since: options.since, until: Date.now() },
    insufficient_data_reason: totalEdits === 0 ? 'not enough coordination data' : null,
    edits_without_claims: metric(editsWithoutClaims, totalEdits),
    sessions_ended_without_handoff: metric(3, 7),
    blockers_without_messages: metric(5, 8),
    proposals_without_reinforcement: metric(7, 12),
  };
}

function metric(count: number, denominator: number): TestDiscrepancyMetric {
  return {
    count,
    denominator,
    rate: denominator > 0 ? count / denominator : 0,
    examples: [],
    truncated: false,
  };
}

function coordinationRow(body: string, label: string): string {
  const labelAt = body.indexOf(label);
  expect(labelAt).toBeGreaterThanOrEqual(0);
  const rowStart = body.lastIndexOf('<div class="coordination-row"', labelAt);
  const nextRow = body.indexOf('<div class="coordination-row"', labelAt);
  const panelEnd = body.indexOf('</div>\n    </div>', labelAt);
  const rowEnd = nextRow === -1 ? panelEnd : nextRow;
  return body.slice(rowStart, rowEnd);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-worker-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  discrepancyReportMockState.reportByStore = new WeakMap<object, unknown>();
  discrepancyReportMockState.buildDiscrepancyReport.mockImplementation(buildMockDiscrepancyReport);
  app = buildApp(store, undefined, {
    discrepancyReportBuilder: discrepancyReportMockState.buildDiscrepancyReport,
  });
});

afterEach(() => {
  vi.useRealTimers();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('worker HTTP', () => {
  it('GET /healthz returns ok', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('GET /api/sessions returns a session list', async () => {
    seed();
    const res = await app.request('/api/sessions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((s) => s.id)).toContain('s1');
  });

  it('GET /api/hivemind returns active runtime lanes', async () => {
    const repoRoot = join(dir, 'repo-runtime');
    seedRuntime(repoRoot);
    const appWithRuntime = buildApp(store, undefined, { hivemindRepoRoots: [repoRoot] });

    const res = await appWithRuntime.request('/api/hivemind');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session_count: number;
      sessions: Array<{ branch: string; task: string }>;
    };
    expect(body.session_count).toBe(1);
    expect(body.sessions[0]).toMatchObject({
      branch: 'agent/codex/viewer-task',
      task: 'Render active lanes in worker viewer',
    });
  });

  it('GET /api/hivemind reuses a short cache during browser refresh bursts', async () => {
    const repoRoot = join(dir, 'repo-runtime-cache');
    seedRuntime(repoRoot);
    const appWithRuntime = buildApp(store, undefined, { hivemindRepoRoots: [repoRoot] });

    const first = (await (await appWithRuntime.request('/api/hivemind')).json()) as {
      session_count: number;
    };
    rmSync(join(repoRoot, '.omx'), { recursive: true, force: true });
    const cached = (await (await appWithRuntime.request('/api/hivemind')).json()) as {
      session_count: number;
    };
    await new Promise((resolve) => setTimeout(resolve, 550));
    const refreshed = (await (await appWithRuntime.request('/api/hivemind')).json()) as {
      session_count: number;
    };

    expect(first.session_count).toBe(1);
    expect(cached.session_count).toBe(1);
    expect(refreshed.session_count).toBe(0);
  });

  it('GET /api/hivemind returns GX file-lock fallback lanes', async () => {
    const repoRoot = join(dir, 'repo-file-locks');
    seedFileLocks(repoRoot);
    const appWithRuntime = buildApp(store, undefined, { hivemindRepoRoots: [repoRoot] });

    const res = await appWithRuntime.request('/api/hivemind');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session_count: number;
      sessions: Array<{ branch: string; source: string; locked_file_count: number }>;
    };
    expect(body.session_count).toBe(1);
    expect(body.sessions[0]).toMatchObject({
      branch: 'agent/codex/viewer-locks',
      source: 'file-lock',
      locked_file_count: 1,
    });
  });

  it('GET /api/colony/discrepancy returns the structured report', async () => {
    seedCoordinationEdits({ unclaimed: 1, claimed: 1 });

    const res = await app.request('/api/colony/discrepancy?since=0');
    expect(res.status).toBe(200);
    const body = (await res.json()) as TestDiscrepancyReport;

    expect(discrepancyReportMockState.buildDiscrepancyReport).toHaveBeenCalledWith(store, {
      since: 0,
    });
    expect(body.insufficient_data_reason).toBeNull();
    expect(body.edits_without_claims.count).toBe(1);
    expect(body.sessions_ended_without_handoff.count).toBe(3);
    expect(body.blockers_without_messages.count).toBe(5);
    expect(body.proposals_without_reinforcement.count).toBe(7);
  });

  it('GET /api/sessions/:id/observations returns expanded text', async () => {
    seed();
    const res = await app.request('/api/sessions/s1/observations');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ content: string }>;
    expect(rows.length).toBeGreaterThan(0);
    // Database abbreviation should be expanded for the viewer.
    expect(rows.some((r) => /database/.test(r.content))).toBe(true);
    // Tech tokens preserved.
    expect(rows.some((r) => r.content.includes('/etc/caveman.conf'))).toBe(true);
  });

  it('GET /api/sessions/:id/observations honours ?around for paging within a session', async () => {
    const { sessionId, a } = seed();
    const res = await app.request(`/api/sessions/${sessionId}/observations?around=${a}&limit=2`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ id: number }>;
    expect(rows.map((r) => r.id)).toContain(a);
  });

  it('GET /api/sessions/:id/observations with ?around pointing at a foreign-session id returns [] (no silent cross-session bleed)', async () => {
    const { a } = seed();
    store.startSession({ id: 's2', ide: 'codex', cwd: '/tmp' });
    const foreign = store.addObservation({
      session_id: 's2',
      kind: 'note',
      content: 'lives in s2',
    });
    expect(foreign).not.toBe(a);

    // around=foreign-id while session=s1 must NOT spill s2's row into s1's
    // window — Storage.timeline filters by session_id, so the result is [].
    const res = await app.request(`/api/sessions/s1/observations?around=${foreign}&limit=10`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ id: number; session_id: string }>;
    expect(rows).toEqual([]);
  });

  it('GET /api/sessions/:id/observations ignores a non-numeric ?around value', async () => {
    seed();
    const res = await app.request('/api/sessions/s1/observations?around=garbage');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<unknown>;
    expect(rows.length).toBeGreaterThan(0);
  });

  it('GET /api/search returns matching observations', async () => {
    seed();
    const res = await app.request('/api/search?q=config');
    expect(res.status).toBe(200);
    const hits = (await res.json()) as Array<{ id: number; snippet: string }>;
    expect(hits.length).toBeGreaterThan(0);
  });

  it('GET / renders the session index HTML', async () => {
    seed();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('s1');
  });

  it('GET / omits stranded sessions when the stranded list is empty', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('Stranded sessions');
    expect(body).not.toContain('data-stranded="true"');
  });

  it('GET / renders stranded sessions as the top rescue lane', async () => {
    const { sessionId, lastError } = seedStrandedSession();

    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.text();
    const strandedStart = body.indexOf('<section class="stranded-section"');
    const strandedSection = body.slice(strandedStart, body.indexOf('</section>', strandedStart));

    expect(body.indexOf('Stranded sessions')).toBeLessThan(body.indexOf('Hivemind runtime'));
    expect(body).toContain('data-stranded="true"');
    expect(body).toContain(`data-session-id="${sessionId}"`);
    expect(body).toContain('codex-strand...');
    expect(body).toContain('stranded · rescue available');
    expect(body).toContain('agent/codex/plans-stranded');
    expect(body).toContain('/repo/colony');
    expect(body).toContain('12 minutes ago');
    expect(body).toContain('4 held claims');
    expect(body).toContain('+1 more');
    expect(strandedSection).toContain('apps/worker/src/viewer.ts');
    expect(strandedSection).toContain('apps/worker/src/server.ts');
    expect(strandedSection).toContain('apps/worker/test/server.test.ts');
    expect(strandedSection).not.toContain('packages/core/src/rescue.ts');
    expect(body).toContain(lastError.slice(0, 77));
    expect(body).not.toContain(lastError);
  });

  it('GET / renders rescue action that posts the stranded session id', async () => {
    const { sessionId } = seedStrandedSession();

    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain(`method="post"`);
    expect(body).toContain(`action="/api/colony/stranded/${encodeURIComponent(sessionId)}/rescue"`);
    expect(body).toContain(`data-action="rescue-stranded"`);
    expect(body).toContain(`data-session-id="${sessionId}"`);
    expect(body).toContain(`fetch(form.action, { method: 'POST'`);
  });

  it('GET / renders the Hivemind runtime dashboard', async () => {
    const repoRoot = join(dir, 'repo-dashboard');
    seedRuntime(repoRoot);
    const appWithRuntime = buildApp(store, undefined, { hivemindRepoRoots: [repoRoot] });

    const res = await appWithRuntime.request('/');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Hivemind runtime');
    expect(body).toContain('Render active lanes in worker viewer');
    expect(body).toContain('runtime clean');
  });

  it('GET / renders unclaimed-edit diagnostics', async () => {
    store.startSession({ id: 'diag-session', ide: 'codex', cwd: '/repo' });
    const task = store.storage.findOrCreateTask({
      title: 'diagnostic-task',
      repo_root: '/repo',
      branch: 'agent/codex/diagnostic-task',
      created_by: 'diag-session',
    });
    store.addObservation({
      session_id: 'diag-session',
      kind: 'tool_use',
      content: 'Edit src/orphan.ts',
      task_id: task.id,
      metadata: { tool: 'Edit', file_path: 'src/orphan.ts' },
    });

    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Diagnostic');
    expect(body).toContain('edits without proactive claims (last 5m)');
    expect(body).toContain('<span class="count">1</span>');
    expect(body).toContain('src/orphan.ts');
  });

  it('GET / renders a Coordination behavior panel between diagnostic and heat-map', async () => {
    seedCoordinationEdits({ unclaimed: 1, claimed: 1 });

    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain('Coordination behavior');
    expect(body.indexOf('Diagnostic')).toBeLessThan(body.indexOf('Coordination behavior'));
    expect(body.indexOf('Coordination behavior')).toBeLessThan(
      body.indexOf('Recent claims heat-map'),
    );
  });

  it('GET / renders the edits-without-claims rate from seeded data', async () => {
    seedCoordinationEdits({ unclaimed: 24, claimed: 18 });

    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.text();
    const row = coordinationRow(body, 'Edits without claims');

    expect(row).toContain('57% (24 of 42)');
    expect(row).toContain('style="--rate: 57%;"');
  });

  it('GET / collapses the Coordination behavior panel when data is insufficient', async () => {
    setDiscrepancyReport({
      window: { since: Date.now() - 24 * 60 * 60_000, until: Date.now() },
      insufficient_data_reason: 'not enough coordination data',
      edits_without_claims: metric(0, 0),
      sessions_ended_without_handoff: metric(0, 0),
      blockers_without_messages: metric(0, 0),
      proposals_without_reinforcement: metric(0, 0),
    });

    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.text();
    const panelStart = body.indexOf('Coordination behavior');
    const panel = body.slice(panelStart, body.indexOf('Recent claims heat-map'));

    expect(panel).toContain('No coordination behavior report: not enough coordination data.');
    expect(panel).not.toContain('coordination-row');
  });

  it('GET / maps Coordination behavior bar colors to rate thresholds', async () => {
    setDiscrepancyReport({
      window: { since: Date.now() - 24 * 60 * 60_000, until: Date.now() },
      insufficient_data_reason: null,
      edits_without_claims: metric(51, 100),
      sessions_ended_without_handoff: metric(1, 2),
      blockers_without_messages: metric(19, 100),
      proposals_without_reinforcement: metric(1, 5),
    });

    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(coordinationRow(body, 'Edits without claims')).toContain('data-rate-level="red"');
    expect(coordinationRow(body, 'Sessions w/o handoff')).toContain('data-rate-level="yellow"');
    expect(coordinationRow(body, 'Blockers without messages')).toContain('data-rate-level="green"');
    expect(coordinationRow(body, 'Proposals abandoned')).toContain('data-rate-level="yellow"');
  });

  it('GET / renders the recent claims heat-map with file paths', async () => {
    store.startSession({ id: 'claim-session', ide: 'codex', cwd: '/repo' });
    const thread = TaskThread.open(store, {
      repo_root: '/repo',
      branch: 'agent/codex/claim-task',
      session_id: 'claim-session',
    });
    thread.join('claim-session', 'codex');
    thread.claimFile({ session_id: 'claim-session', file_path: 'apps/worker/src/viewer.ts' });

    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Recent claims heat-map');
    expect(body).toContain('apps/worker/src/viewer.ts');
    expect(body).toContain('claim-session');
  });

  it('GET /sessions/:id renders observation HTML', async () => {
    seed();
    const res = await app.request('/sessions/s1');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('/etc/caveman.conf');
  });

  it('GET /sessions/:unknown returns 404', async () => {
    const res = await app.request('/sessions/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('GET /api/colony/tasks lists tasks with pending handoff counts and participants', async () => {
    const task = store.storage.findOrCreateTask({
      title: 'viewer-task',
      repo_root: '/tmp/repo-a',
      branch: 'agent/codex/viewer-task',
      created_by: 'sess-1',
    });
    store.startSession({ id: 'sess-1', ide: 'codex', cwd: '/tmp/repo-a' });
    store.storage.addTaskParticipant({
      task_id: task.id,
      session_id: 'sess-1',
      agent: 'codex',
    });
    store.addObservation({
      session_id: 'sess-1',
      kind: 'handoff',
      content: 'pass ownership',
      task_id: task.id,
      metadata: {
        status: 'pending',
        from_agent: 'codex',
        to_agent: 'claude',
        summary: 'take over auth module',
        expires_at: Date.now() + 60_000,
      },
    });

    const res = await app.request('/api/colony/tasks');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: number;
      repo_root: string;
      branch: string;
      pending_handoff_count: number;
      participants: Array<{ agent: string; session_id: string }>;
    }>;
    const row = body.find((t) => t.id === task.id);
    expect(row).toBeDefined();
    expect(row?.repo_root).toBe('/tmp/repo-a');
    expect(row?.branch).toBe('agent/codex/viewer-task');
    expect(row?.pending_handoff_count).toBe(1);
    expect(row?.participants.map((p) => p.agent)).toContain('codex');
  });

  it('GET /api/colony/tasks filters by repo_root', async () => {
    store.storage.findOrCreateTask({
      title: 'task-a',
      repo_root: '/tmp/repo-a',
      branch: 'agent/a/work',
      created_by: 'sess-a',
    });
    store.storage.findOrCreateTask({
      title: 'task-b',
      repo_root: '/tmp/repo-b',
      branch: 'agent/b/work',
      created_by: 'sess-b',
    });
    const res = await app.request('/api/colony/tasks?repo_root=/tmp/repo-a');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ repo_root: string }>;
    expect(body.every((t) => t.repo_root === '/tmp/repo-a')).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  it('GET /api/colony/tasks/:id/attention surfaces pending handoffs and wake requests', async () => {
    const task = store.storage.findOrCreateTask({
      title: 'attention-task',
      repo_root: '/tmp/repo-attn',
      branch: 'agent/codex/attn',
      created_by: 'sess-attn',
    });
    store.startSession({ id: 'sess-attn', ide: 'codex', cwd: '/tmp/repo-attn' });
    store.storage.addTaskParticipant({
      task_id: task.id,
      session_id: 'sess-attn',
      agent: 'codex',
    });
    const handoffId = store.addObservation({
      session_id: 'sess-attn',
      kind: 'handoff',
      content: 'hand it off',
      task_id: task.id,
      metadata: {
        status: 'pending',
        from_agent: 'codex',
        to_agent: 'claude',
        summary: 'finish the migration',
        expires_at: Date.now() + 60_000,
      },
    });
    const wakeId = store.addObservation({
      session_id: 'sess-attn',
      kind: 'wake_request',
      content: 'ping',
      task_id: task.id,
      metadata: {
        kind: 'wake_request',
        status: 'pending',
        to_agent: 'claude',
        reason: 'need review',
        expires_at: Date.now() + 60_000,
      },
    });

    const res = await app.request(`/api/colony/tasks/${task.id}/attention`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pending_handoffs: Array<{ id: number; to_agent: string | null; status: string }>;
      pending_wakes: Array<{ id: number; status: string }>;
      recent: Array<{ id: number; kind: string }>;
    };
    expect(body.pending_handoffs.find((h) => h.id === handoffId)?.to_agent).toBe('claude');
    expect(body.pending_wakes.find((w) => w.id === wakeId)?.status).toBe('pending');
    expect(body.recent.length).toBeGreaterThan(0);
    expect(body.recent.some((r) => r.kind === 'wake_request')).toBe(true);
  });
});
