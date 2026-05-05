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

function seedStrandedSession(options: { live?: boolean } = {}): {
  sessionId: string;
  lastError: string;
  taskId: number;
  repoRoot: string;
  worktreePath: string;
} {
  const now = Date.UTC(2026, 3, 28, 12, 0, 0);
  vi.setSystemTime(now);
  const sessionId = 'codex-stranded-session-abcdef';
  const lastActivity = now - 12 * 60_000;
  const repoRoot = options.live ? join(dir, 'repo-colony') : '/repo/colony';
  const worktreePath = join(repoRoot, '.omx', 'agent-worktrees', sessionId);
  if (options.live) {
    const activeSessionDir = join(repoRoot, '.omx', 'state', 'active-sessions');
    mkdirSync(activeSessionDir, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(
      join(activeSessionDir, `${sessionId}.json`),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          repoRoot,
          branch: 'agent/codex/plans-stranded',
          taskName: 'plans stranded rescue surface',
          latestTaskPreview: 'Preview and rescue stranded session',
          agentName: 'codex',
          worktreePath,
          pid: process.pid,
          cliName: 'codex',
          sessionKey: sessionId,
          startedAt: new Date(lastActivity - 1_000).toISOString(),
          lastHeartbeatAt: new Date(now).toISOString(),
          state: 'working',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }
  store.storage.createSession({
    id: sessionId,
    ide: 'codex',
    cwd: repoRoot,
    started_at: lastActivity - 1_000,
    metadata: null,
  });
  const task = store.storage.findOrCreateTask({
    title: 'plans stranded rescue surface',
    repo_root: repoRoot,
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
  return { sessionId, lastError, taskId: task.id, repoRoot, worktreePath };
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

function seedClaimCoverage(counts: {
  edits: number;
  autoClaims: number;
  explicitClaims?: number;
  conflicts?: number;
}): void {
  store.startSession({ id: 'coverage-session', ide: 'codex', cwd: '/repo' });
  const task = store.storage.findOrCreateTask({
    title: 'claim-coverage-task',
    repo_root: '/repo',
    branch: 'agent/codex/claim-coverage-task',
    created_by: 'coverage-session',
  });
  for (let i = 0; i < counts.edits; i++) {
    const filePath = `src/coverage-${i}.ts`;
    store.addObservation({
      session_id: 'coverage-session',
      kind: 'tool_use',
      content: `Edit ${filePath}`,
      task_id: task.id,
      metadata: { tool: 'Edit', file_path: filePath },
    });
  }
  for (let i = 0; i < counts.autoClaims; i++) {
    const filePath = `src/coverage-${i}.ts`;
    store.addObservation({
      session_id: 'coverage-session',
      kind: 'auto-claim',
      content: `coverage-session auto-claimed ${filePath}`,
      task_id: task.id,
      metadata: { source: 'post-tool-use', tool: 'Edit', file_path: filePath },
    });
  }
  for (let i = 0; i < (counts.explicitClaims ?? 0); i++) {
    const filePath = `src/explicit-${i}.ts`;
    store.addObservation({
      session_id: 'coverage-session',
      kind: 'claim',
      content: `claim ${filePath}`,
      task_id: task.id,
      metadata: { kind: 'claim', file_path: filePath },
    });
  }
  for (let i = 0; i < (counts.conflicts ?? 0); i++) {
    const filePath = `src/conflict-${i}.ts`;
    store.addObservation({
      session_id: 'coverage-session',
      kind: 'claim-conflict',
      content: `coverage-session edited ${filePath} while other-session held the claim`,
      task_id: task.id,
      metadata: {
        source: 'post-tool-use',
        tool: 'Edit',
        file_path: filePath,
        other_session: 'other-session',
      },
    });
  }
}

function seedBashCoordinationEvents(counts: { gitOps: number; fileOps: number }): void {
  store.startSession({ id: 'bash-session', ide: 'codex', cwd: '/repo' });
  for (let i = 0; i < counts.gitOps; i++) {
    store.addObservation({
      session_id: 'bash-session',
      kind: 'git-op',
      content: `Bash git checkout: git checkout branch-${i}`,
      metadata: { tool: 'Bash', source: 'bash-parser', op: 'checkout' },
    });
  }
  for (let i = 0; i < counts.fileOps; i++) {
    store.addObservation({
      session_id: 'bash-session',
      kind: 'file-op',
      content: `Bash file mv: src/a-${i}.ts, src/b-${i}.ts`,
      metadata: { tool: 'Bash', source: 'bash-parser', op: 'mv', file_path: `src/a-${i}.ts` },
    });
  }
}

function seedLowAdoptionHealth(): void {
  const repoRoot = '/repo-adoption';
  const branch = 'agent/codex/adoption-task';
  store.startSession({ id: 'adoption-session', ide: 'codex', cwd: repoRoot });
  const task = store.storage.findOrCreateTask({
    title: 'adoption-task',
    repo_root: repoRoot,
    branch,
    created_by: 'adoption-session',
  });
  for (let i = 0; i < 4; i++) {
    store.addObservation({
      session_id: 'adoption-session',
      kind: 'tool_use',
      content: `Tool: colony.task_post ${i}`,
      task_id: task.id,
      metadata: { tool: 'mcp__colony__task_post' },
    });
  }
  store.storage.insertProposal({
    repo_root: repoRoot,
    branch,
    summary: 'adopt proposal lane',
    rationale: 'future work should not stay chat-only',
    touches_files: '[]',
    proposed_by: 'adoption-session',
  });

  const planRoot = store.storage.findOrCreateTask({
    title: 'Adoption plan',
    repo_root: repoRoot,
    branch: 'spec/adoption-plan',
    created_by: 'adoption-session',
  });
  const subtask = store.storage.findOrCreateTask({
    title: 'Adoption plan subtask',
    repo_root: repoRoot,
    branch: 'spec/adoption-plan/sub-1',
    created_by: 'adoption-session',
  });
  store.addObservation({
    session_id: 'adoption-session',
    kind: 'plan-subtask',
    content: 'Claim ready adoption panel\n\nWire the viewer adoption panel.',
    task_id: subtask.id,
    metadata: {
      status: 'available',
      subtask_index: 1,
      title: 'Claim ready adoption panel',
      description: 'Wire the viewer adoption panel.',
      depends_on: [],
      file_scope: ['apps/worker/src/viewer.ts'],
      parent_plan_title: 'Adoption plan',
      parent_spec_task_id: planRoot.id,
    },
  });
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

  it('GET /api/colony/claim-coverage returns the claim coverage snapshot', async () => {
    seedClaimCoverage({ edits: 3, autoClaims: 2, explicitClaims: 1, conflicts: 1 });
    seedBashCoordinationEvents({ gitOps: 1, fileOps: 2 });

    const res = await app.request('/api/colony/claim-coverage?since=0');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      edit_write_count: number;
      auto_claim_count: number;
      explicit_claim_count: number;
      claim_conflict_count: number;
      bash_git_file_op_count: number;
      bash_git_op_count: number;
      bash_file_op_count: number;
    };

    expect(body.edit_write_count).toBe(3);
    expect(body.auto_claim_count).toBe(2);
    expect(body.explicit_claim_count).toBe(1);
    expect(body.claim_conflict_count).toBe(1);
    expect(body.bash_git_file_op_count).toBe(3);
    expect(body.bash_git_op_count).toBe(1);
    expect(body.bash_file_op_count).toBe(2);
  });

  it('GET /api/colony/adoption-health returns the health adoption payload fields', async () => {
    seedLowAdoptionHealth();

    const res = await app.request('/api/colony/adoption-health?since=0');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      task_post_vs_task_message: { task_post_calls: number; task_message_calls: number };
      proposal_health: { proposals_seen: number; pending: number; promoted: number };
      ready_to_claim_vs_claimed: { plan_subtasks: number; ready_to_claim: number; claimed: number };
    };

    expect(body.task_post_vs_task_message).toMatchObject({
      task_post_calls: 4,
      task_message_calls: 0,
    });
    expect(body.proposal_health).toMatchObject({
      proposals_seen: 1,
      pending: 1,
      promoted: 0,
    });
    expect(body.ready_to_claim_vs_claimed).toMatchObject({
      plan_subtasks: 1,
      ready_to_claim: 1,
      claimed: 0,
    });
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
    expect(body).toContain(
      `data-preview-action="/api/colony/stranded/${encodeURIComponent(sessionId)}/rescue/preview"`,
    );
    expect(body).toContain(`data-action="rescue-stranded"`);
    expect(body).toContain(`data-session-id="${sessionId}"`);
    expect(body).toContain(`data-role="confirm-rescue" hidden`);
    expect(body).toContain('data-rescue-preview hidden');
    expect(body).toContain('Loading rescue preview...');
    expect(body).toContain('Applying rescue...');
  });

  it('GET /api/colony/stranded/:id/rescue/preview returns a safe preview only', async () => {
    const { sessionId, taskId } = seedStrandedSession();

    const res = await app.request(
      `/api/colony/stranded/${encodeURIComponent(sessionId)}/rescue/preview`,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      mode: string;
      rescued: Array<{
        held_claim_count: number;
        held_claims: Array<{ file_path: string }>;
      }>;
      command: string;
    };
    expect(body.ok).toBe(true);
    expect(body.mode).toBe('preview');
    expect(body.command).toContain(`/api/colony/stranded/${encodeURIComponent(sessionId)}/rescue`);
    expect(body.rescued[0]?.held_claim_count).toBe(4);
    expect(body.rescued[0]?.held_claims.map((claim) => claim.file_path)).toEqual(
      expect.arrayContaining([
        'apps/worker/src/viewer.ts',
        'apps/worker/src/server.ts',
        'apps/worker/test/server.test.ts',
        'packages/core/src/rescue.ts',
      ]),
    );
    expect(store.storage.listClaims(taskId)).toHaveLength(4);
    expect(store.storage.taskObservationsByKind(taskId, 'relay', 10)).toHaveLength(0);
    expect(store.storage.taskObservationsByKind(taskId, 'rescue-stranded', 10)).toHaveLength(0);
  });

  it('POST /api/colony/stranded/:id/rescue applies only the selected rescue', async () => {
    const { sessionId, taskId } = seedStrandedSession();

    const res = await app.request(`/api/colony/stranded/${encodeURIComponent(sessionId)}/rescue`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      mode: string;
      message: string;
      rescued: Array<{ audit_observation_id: number; held_claim_count: number }>;
    };
    expect(body.ok).toBe(true);
    expect(body.mode).toBe('apply');
    expect(body.message).toContain('Rescue applied');
    expect(body.rescued[0]?.audit_observation_id).toBeGreaterThan(0);
    expect(body.rescued[0]?.held_claim_count).toBe(4);
    expect(store.storage.listClaims(taskId)).toHaveLength(0);
    expect(store.storage.taskObservationsByKind(taskId, 'relay', 10)).toHaveLength(0);
    expect(store.storage.getObservation(body.rescued[0]?.audit_observation_id ?? -1)?.kind).toBe(
      'rescue-stranded',
    );
    expect(store.storage.getSession(sessionId)?.ended_at).toEqual(expect.any(Number));
  });

  it('GET /api/colony/stranded/:id/rescue/preview reports failure for non-stranded sessions', async () => {
    const res = await app.request('/api/colony/stranded/missing-session/rescue/preview');

    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; message: string; skipped: unknown[] };
    expect(body.ok).toBe(false);
    expect(body.message).toContain('not stranded');
    expect(body.skipped).toEqual([{ session_id: 'missing-session', reason: 'not stranded' }]);
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

  it('GET / renders claim coverage counts in Diagnostic', async () => {
    seedClaimCoverage({ edits: 10, autoClaims: 10 });

    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain('Edit/Write count');
    expect(body).toContain('Auto-claim count');
    expect(body).toContain('Explicit claim count');
    expect(body).toContain('Claim-conflict count');
    expect(body).toContain('10 / 10');
    expect(body).not.toContain('hook integration may be broken');
  });

  it('GET / warns when auto-claim coverage is below Edit/Write count', async () => {
    seedClaimCoverage({ edits: 10, autoClaims: 9 });

    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain('hook integration may be broken');
  });

  it('GET / renders a Coordination behavior panel between diagnostic and heat-map', async () => {
    seedCoordinationEdits({ unclaimed: 1, claimed: 1 });

    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain('Coordination behavior');
    expect(body.indexOf('Diagnostic')).toBeLessThan(body.indexOf('Coordination behavior'));
    expect(body.indexOf('Coordination behavior')).toBeLessThan(
      body.indexOf('File activity heat-map'),
    );
  });

  it('GET / renders adoption-health badges for low coordination adoption', async () => {
    seedLowAdoptionHealth();

    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain('Adoption health');
    expect(body).toContain('directed messages low');
    expect(body).toContain('proposal adoption low');
    expect(body).toContain('ready subtasks unclaimed');
    expect(body).toContain('task_post_vs_task_message');
    expect(body).toContain('proposal_health');
    expect(body).toContain('ready_to_claim_vs_claimed');
    expect(body.indexOf('Coordination behavior')).toBeLessThan(body.indexOf('Adoption health'));
    expect(body.indexOf('Adoption health')).toBeLessThan(body.indexOf('File activity heat-map'));
  });

  it('GET / renders the edits-without-claims rate from seeded data', async () => {
    seedCoordinationEdits({ unclaimed: 24, claimed: 18 });
    seedBashCoordinationEvents({ gitOps: 1, fileOps: 2 });

    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.text();
    const row = coordinationRow(body, 'Edits without claims');
    const bashRow = coordinationRow(body, 'Bash coordination events');

    expect(row).toContain('57% (24 of 42)');
    expect(row).toContain('style="--rate: 57%;"');
    expect(bashRow).toContain('3 (1 git-op + 2 file-op)');
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
    const panel = body.slice(panelStart, body.indexOf('File activity heat-map'));

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

  it('GET / renders the file activity heat-map with decayed heat', async () => {
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
    expect(body).toContain('File activity heat-map');
    expect(body).toContain('data-file-heat-root');
    expect(body).toContain('/api/colony/file-heat');
    expect(body).toContain('function FileHeatTile(row)');
    expect(body).not.toContain('&lt;div class=&quot;claim-tile&quot;');
    expect(body).not.toContain('&lt;div class="claim-tile"');
  });

  it('GET /api/colony/file-heat returns structured heat-map rows', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-29T10:00:00.000Z'));
    store.startSession({ id: 'claim-session', ide: 'codex', cwd: '/repo' });
    const thread = TaskThread.open(store, {
      repo_root: '/repo',
      branch: 'agent/codex/claim-task',
      session_id: 'claim-session',
    });
    thread.join('claim-session', 'codex');
    thread.claimFile({ session_id: 'claim-session', file_path: 'apps/worker/src/viewer.ts' });

    const res = await app.request('/api/colony/file-heat');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('<div');
    expect(body).toMatchInlineSnapshot(`
      [
        {
          "branch": "agent/codex/claim-task",
          "event_count": 1,
          "file_path": "apps/worker/src/viewer.ts",
          "heat": 1,
          "kind": "file_activity",
          "last_seen": "2026-04-29T10:00:00.000Z",
        },
      ]
    `);
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

  describe('POST /api/bridge/lifecycle (daemon fast-path)', () => {
    const baseEnvelope = {
      schema: 'colony-omx-lifecycle-v1',
      event_id: 'evt_daemon_fastpath_001',
      event_name: 'pre_tool_use',
      session_id: 'sess_daemon_fastpath',
      agent: 'claude',
      cwd: '/workspace/colony',
      repo_root: '/workspace/colony',
      branch: 'agent/claude/daemon-fastpath-test',
      timestamp: '2026-05-05T22:00:00.000Z',
      source: 'omx',
      tool_name: 'Edit',
      tool_input: {
        operation: 'replace',
        paths: [
          { path: 'apps/worker/src/server.ts', role: 'target', kind: 'file' },
        ],
        input_summary: 'daemon fast-path round-trip test',
        edit_count: 1,
        file_count: 1,
        redacted: true,
      },
    };

    it('routes a valid envelope through the long-lived store', async () => {
      const res = await app.request('/api/bridge/lifecycle', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-colony-ide': 'claude-code',
          'x-colony-cwd': '/workspace/colony',
        },
        body: JSON.stringify(baseEnvelope),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        event_type?: string;
        route?: string;
        error?: string;
      };
      expect(body.ok).toBe(true);
      expect(body.event_type).toBe('pre_tool_use');
      // Session must have been created against the long-lived store, not a
      // freshly-opened-and-closed one. Reading it back proves the daemon
      // path is actually using the injected store.
      expect(store.storage.getSession('sess_daemon_fastpath')).toBeDefined();
    });

    it('treats a duplicate envelope as a no-op route=duplicate', async () => {
      const dupEnvelope = { ...baseEnvelope, event_id: 'evt_daemon_dup_001' };
      const first = await app.request('/api/bridge/lifecycle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(dupEnvelope),
      });
      expect(first.status).toBe(200);
      const second = await app.request('/api/bridge/lifecycle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(dupEnvelope),
      });
      expect(second.status).toBe(200);
      const body = (await second.json()) as { ok: boolean; route?: string; duplicate?: boolean };
      expect(body.ok).toBe(true);
      expect(body.duplicate).toBe(true);
      expect(body.route).toBe('duplicate');
    });

    it('returns ok:false on a malformed envelope without throwing', async () => {
      const res = await app.request('/api/bridge/lifecycle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"this":"is not a colony envelope"}',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe('string');
    });
  });
});
