import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, TaskThread } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTaskPreface } from '../src/handlers/session-start.js';

/**
 * End-to-end proof that the task-thread primitive (@colony/core), the
 * storage layer, and the SessionStart hook injection are wired together
 * correctly. If these are green, a fresh codex session landing on a branch
 * where claude just left a handoff *will* see the handoff in its
 * additionalContext and will know how to accept it.
 */
let dir: string;
let store: MemoryStore;
let repo: string;

function fakeGitCheckout(path: string, branch: string): void {
  // We only need a `.git/HEAD` pointing at a branch — detectRepoBranch
  // doesn't care whether the rest of the repo is real.
  mkdirSync(join(path, '.git'), { recursive: true });
  writeFileSync(join(path, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-hook-inject-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  fakeGitCheckout(repo, 'feat/handoff');
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SessionStart task preface injection', () => {
  it('surfaces a pending handoff to the receiving agent with a ready-to-copy accept call', () => {
    // A (claude) has been working on the branch and posts a handoff to codex.
    store.startSession({ id: 'A', ide: 'claude-code', cwd: repo });
    const thread = TaskThread.open(store, {
      repo_root: repo,
      branch: 'feat/handoff',
      session_id: 'A',
    });
    thread.join('A', 'claude');
    thread.handOff({
      from_session_id: 'A',
      from_agent: 'claude',
      to_agent: 'codex',
      summary: 'viewer is done, API is next',
      next_steps: ['wire POST /api/tasks/:id/accept', 'add auth guard'],
      blockers: ['TTL check assumes server clock'],
      transferred_files: ['src/api.ts'],
    });

    // B (codex) now starts in the same repo — SessionStart would fire here.
    store.startSession({ id: 'B', ide: 'codex', cwd: repo });
    const preface = buildTaskPreface(store, {
      session_id: 'B',
      cwd: repo,
      ide: 'codex',
    });

    // Header: B knows it's on a shared task with claude.
    expect(preface).toContain('Task thread');
    expect(preface).toContain('claude');

    // Handoff body surfaces the sender's context verbatim.
    expect(preface).toContain('PENDING HANDOFF');
    expect(preface).toContain('viewer is done, API is next');
    expect(preface).toContain('wire POST /api/tasks/:id/accept');
    expect(preface).toContain('TTL check assumes server clock');
    expect(preface).toContain('src/api.ts');

    // The copy-paste-ready accept call includes this session's id. Without
    // the inline session_id, agents routinely call task_accept_handoff with
    // only the observation id and the MCP tool rejects the call.
    expect(preface).toContain('task_accept_handoff');
    expect(preface).toContain('session_id="B"');

    // A decline hint is offered too so the receiver has an explicit exit
    // ramp rather than silently letting the handoff expire.
    expect(preface).toContain('task_decline_handoff');
  });

  it('surfaces a pending wake request with a ready-to-copy ack call', () => {
    store.startSession({ id: 'A', ide: 'claude-code', cwd: repo });
    const thread = TaskThread.open(store, {
      repo_root: repo,
      branch: 'feat/handoff',
      session_id: 'A',
    });
    thread.join('A', 'claude');
    thread.requestWake({
      from_session_id: 'A',
      from_agent: 'claude',
      to_agent: 'codex',
      reason: 'stuck on migration shape, need a second pair of eyes',
      next_step: 'look at packages/storage/src/schema.ts',
    });

    store.startSession({ id: 'B', ide: 'codex', cwd: repo });
    const preface = buildTaskPreface(store, {
      session_id: 'B',
      cwd: repo,
      ide: 'codex',
    });

    expect(preface).toContain('PENDING WAKE');
    expect(preface).toContain('stuck on migration shape');
    expect(preface).toContain('packages/storage/src/schema.ts');
    expect(preface).toContain('task_ack_wake');
    expect(preface).toContain('session_id="B"');
  });
});
