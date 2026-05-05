import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, TaskThread } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTaskPreface } from '../src/handlers/session-start.js';
import { buildConflictPreface } from '../src/handlers/user-prompt-submit.js';

/**
 * Token-budget regression tests. These two prefaces fire on every session
 * resume / every user turn, and they used to scale with all-time-joined
 * participants and full absolute paths — both of which dwarf the actual
 * coordination signal. The cap + compaction here is what keeps Colony's
 * per-session and per-turn overhead bounded.
 */

let dir: string;
let repo: string;
let store: MemoryStore;

function fakeGitCheckout(path: string, branch: string): void {
  mkdirSync(join(path, '.git'), { recursive: true });
  writeFileSync(join(path, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
}

function seedJoinedParticipant(
  thread: TaskThread,
  session_id: string,
  agent: string,
  options: { recentObservation: boolean },
): void {
  store.startSession({ id: session_id, ide: agent, cwd: repo });
  thread.join(session_id, agent);
  if (options.recentObservation) {
    store.addObservation({
      session_id,
      task_id: thread.task_id,
      kind: 'note',
      content: 'still here',
    });
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-preface-trim-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  fakeGitCheckout(repo, 'feat/trim');
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('buildTaskPreface participants cap & recency filter', () => {
  it('caps the joined-with list at 8 entries and surfaces the overflow count', () => {
    store.startSession({ id: 'me', ide: 'claude-code', cwd: repo });
    const thread = TaskThread.open(store, {
      repo_root: repo,
      branch: 'feat/trim',
      session_id: 'me',
    });
    thread.join('me', 'claude');
    for (let i = 0; i < 12; i += 1) {
      seedJoinedParticipant(thread, `peer-${i}-aaaaaaaa`, 'claude', {
        recentObservation: true,
      });
    }

    const preface = buildTaskPreface(store, {
      session_id: 'me',
      cwd: repo,
      ide: 'claude-code',
    });

    expect(preface).toContain('Joined with: ');
    // Cap: 8 visible + "+4 more" overflow tag.
    expect(preface).toContain('(+4 more)');
    // Each visible entry uses the @<8-char-shorthand> render.
    const renderedShorthands = (preface.match(/claude@peer-\d+/g) ?? []).length;
    expect(renderedShorthands).toBe(8);
  });

  it('drops participants with no observation in the last hour from the joined-with line', () => {
    store.startSession({ id: 'me', ide: 'claude-code', cwd: repo });
    const thread = TaskThread.open(store, {
      repo_root: repo,
      branch: 'feat/trim',
      session_id: 'me',
    });
    thread.join('me', 'claude');
    seedJoinedParticipant(thread, 'live-session-1234', 'codex', { recentObservation: true });
    // No recent observation → must not appear in the joined-with line even
    // though the participant row still exists in storage.
    seedJoinedParticipant(thread, 'stale-session-5678', 'codex', { recentObservation: false });

    const preface = buildTaskPreface(store, {
      session_id: 'me',
      cwd: repo,
      ide: 'claude-code',
    });

    expect(preface).toContain('codex@live-ses');
    expect(preface).not.toContain('stale-se');
  });

  it('omits the joined-with header entirely when only stale others exist and there are no pending items', () => {
    store.startSession({ id: 'me', ide: 'claude-code', cwd: repo });
    const thread = TaskThread.open(store, {
      repo_root: repo,
      branch: 'feat/trim',
      session_id: 'me',
    });
    thread.join('me', 'claude');
    seedJoinedParticipant(thread, 'ghost-session-1234', 'codex', { recentObservation: false });

    const preface = buildTaskPreface(store, {
      session_id: 'me',
      cwd: repo,
      ide: 'claude-code',
    });

    // Stale-only participants must not by themselves trigger the
    // "Task thread #X" header; the joined-with line stops rendering
    // once every other participant has aged out of the recency window.
    expect(preface).toBe('');
  });
});

describe('buildConflictPreface path & session-id compaction', () => {
  it('truncates session_id and strips the agent-worktree prefix from claimed paths', () => {
    store.startSession({ id: 'me-1234567890ab', ide: 'claude-code', cwd: repo });
    store.startSession({ id: 'other-abcdef0123', ide: 'codex', cwd: repo });
    const thread = TaskThread.open(store, {
      repo_root: repo,
      branch: 'feat/trim',
      session_id: 'me-1234567890ab',
    });
    thread.join('me-1234567890ab', 'claude');
    thread.join('other-abcdef0123', 'codex');
    thread.claimFile({
      session_id: 'other-abcdef0123',
      file_path:
        '.omx/agent-worktrees/recodee__codex__some-long-task-name-2026-05-05-08-12/apps/frontend/src/components/x.tsx',
    });
    thread.claimFile({
      session_id: 'other-abcdef0123',
      file_path:
        '.omc/agent-worktrees/colony__claude__some-other-2026-05-05/packages/hooks/src/y.ts',
    });

    const preface = buildConflictPreface(store, 'me-1234567890ab');

    expect(preface).toContain('## Files being actively edited by other sessions');
    // Session id collapses to its 8-char shorthand.
    expect(preface).toContain('  other-ab:');
    expect(preface).not.toContain('other-abcdef0123');
    // Worktree-prefixed paths surface the in-sandbox suffix only.
    expect(preface).toContain('apps/frontend/src/components/x.tsx');
    expect(preface).not.toContain('recodee__codex__some-long-task-name');
    expect(preface).toContain('packages/hooks/src/y.ts');
    expect(preface).not.toContain('colony__claude__some-other');
  });

  it('leaves non-worktree paths untouched', () => {
    store.startSession({ id: 'me-1234567890ab', ide: 'claude-code', cwd: repo });
    store.startSession({ id: 'other-abcdef0123', ide: 'codex', cwd: repo });
    const thread = TaskThread.open(store, {
      repo_root: repo,
      branch: 'feat/trim',
      session_id: 'me-1234567890ab',
    });
    thread.join('me-1234567890ab', 'claude');
    thread.join('other-abcdef0123', 'codex');
    thread.claimFile({
      session_id: 'other-abcdef0123',
      file_path: 'apps/frontend/src/utils/account-working.ts',
    });

    const preface = buildConflictPreface(store, 'me-1234567890ab');

    expect(preface).toContain('apps/frontend/src/utils/account-working.ts');
  });
});
