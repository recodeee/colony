import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { type ManagedWorktreeInspection, MemoryStore, TaskThread } from '@colony/core';
import kleur from 'kleur';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildResumeQuotaPayload, renderResumeQuotaPayload } from '../src/commands/resume.js';

const NOW = new Date('2026-04-29T18:00:00.000Z').getTime();

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-resume-test-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  kleur.enabled = false;
});

afterEach(() => {
  vi.useRealTimers();
  kleur.enabled = true;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('resume quota payload', () => {
  it('returns a clear empty response when no quota handoffs exist', () => {
    const payload = buildResumeQuotaPayload(store, {
      repoRoot: '/repo',
      agent: 'codex',
      now: NOW,
      inspectWorktrees: () => [],
    });

    expect(payload).toMatchObject({
      count: 0,
      empty: true,
      message: 'No active quota-exhausted handoffs found.',
    });
    expect(renderResumeQuotaPayload(payload)).toContain('No active quota-exhausted handoffs');
  });

  it('builds a recovery packet for one active quota handoff', () => {
    const taskId = seedQuotaHandoff({
      repoRoot: '/repo',
      branch: 'agent/codex/quota',
      sessionId: 'codex@old',
      lastNote: 'branch=agent/codex/quota; next=finish parser',
      verification: 'pnpm test passed',
    });

    const payload = buildResumeQuotaPayload(store, {
      repoRoot: '/repo',
      agent: 'claude',
      now: NOW,
      inspectWorktrees: () => [
        worktree({
          branch: 'agent/codex/quota',
          path: '/repo/.omx/agent-worktrees/quota',
          dirtyFiles: [{ path: 'src/parser.ts', status: ' M' }],
        }),
      ],
    });

    expect(payload.count).toBe(1);
    expect(payload.packets[0]).toMatchObject({
      task: { id: taskId, title: 'resume quota task', repo_root: '/repo' },
      previous: { agent: 'codex', session_id: 'codex@old' },
      branch: 'agent/codex/quota',
      worktree: '/repo/.omx/agent-worktrees/quota',
      claimed_files: ['src/parser.ts'],
      dirty_files: [{ path: 'src/parser.ts', status: ' M' }],
      last_working_note: 'branch=agent/codex/quota; next=finish parser',
      last_verification: 'pnpm test passed',
    });
    expect(payload.packets[0]?.next_recommended_mcp_call).toContain('task_accept_handoff');
    expect(payload.packets[0]?.next_recommended_shell_command).toBe(
      'cd "/repo/.omx/agent-worktrees/quota" && git status --short',
    );
  });

  it('orders multiple handoffs by preferred repo, priority, then newest', () => {
    seedQuotaHandoff({
      repoRoot: '/other',
      branch: 'agent/codex/newer-other',
      sessionId: 'codex@other',
      nowOffset: 20,
    });
    seedQuotaHandoff({
      repoRoot: '/repo',
      branch: 'agent/claude/exact-old',
      sessionId: 'claude@exact-old',
      nowOffset: 10,
    });
    seedQuotaHandoff({
      repoRoot: '/repo',
      branch: 'agent/codex/exact-new',
      sessionId: 'codex@exact-new',
      nowOffset: 30,
    });

    const payload = buildResumeQuotaPayload(store, {
      repoRoot: '/repo',
      agent: 'codex',
      now: NOW + 60_000,
      inspectWorktrees: () => [],
    });

    expect(payload.packets.map((packet) => packet.branch)).toEqual([
      'agent/codex/exact-new',
      'agent/claude/exact-old',
      'agent/codex/newer-other',
    ]);
  });

  it('omits expired handoffs using existing pending-handoff convention', () => {
    seedQuotaHandoff({
      repoRoot: '/repo',
      branch: 'agent/codex/expired',
      sessionId: 'codex@expired',
      expiresInMs: -1,
    });

    const payload = buildResumeQuotaPayload(store, {
      repoRoot: '/repo',
      agent: 'codex',
      now: NOW,
      inspectWorktrees: () => [],
    });

    expect(payload.empty).toBe(true);
    expect(payload.packets).toEqual([]);
  });
});

function seedQuotaHandoff(args: {
  repoRoot: string;
  branch: string;
  sessionId: string;
  lastNote?: string;
  verification?: string;
  expiresInMs?: number;
  nowOffset?: number;
}): number {
  vi.setSystemTime(NOW + (args.nowOffset ?? 0));
  const agent = args.sessionId.startsWith('claude') ? 'claude' : 'codex';
  store.startSession({
    id: args.sessionId,
    ide: agent === 'claude' ? 'claude-code' : 'codex',
    cwd: args.repoRoot,
  });
  const thread = TaskThread.open(store, {
    repo_root: args.repoRoot,
    branch: args.branch,
    title: 'resume quota task',
    session_id: args.sessionId,
  });
  thread.join(args.sessionId, agent);
  thread.claimFile({ session_id: args.sessionId, file_path: 'src/parser.ts' });
  if (args.lastNote) {
    thread.post({ session_id: args.sessionId, kind: 'note', content: args.lastNote });
  }
  if (args.verification) {
    store.addObservation({
      session_id: args.sessionId,
      kind: 'verification',
      content: args.verification,
      task_id: thread.task_id,
      metadata: { kind: 'verification' },
    });
  }
  thread.handOff({
    from_session_id: args.sessionId,
    from_agent: agent,
    to_agent: 'any',
    summary: 'Session hit usage limit; takeover requested.',
    next_steps: ['Accept this handoff and continue.'],
    blockers: ['quota_exhausted'],
    expires_in_ms: args.expiresInMs ?? 60_000,
  });
  return thread.task_id;
}

function worktree(args: {
  branch: string;
  path: string;
  dirtyFiles?: Array<{ path: string; status: string }>;
}): ManagedWorktreeInspection {
  return {
    branch: args.branch,
    path: args.path,
    managed_root: '.omx/agent-worktrees',
    dirty_files: args.dirtyFiles ?? [],
    claimed_files: [],
    active_session: null,
  };
}
