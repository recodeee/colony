import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readWorktreeContentionReport,
  resolveManagedRepoRoot,
} from '../src/worktree-contention.js';

let dir = '';

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

describe('readWorktreeContentionReport', () => {
  it('reports the same dirty file across .omx and .omc managed worktrees', () => {
    const repoRoot = createRepo();
    const left = addWorktree(repoRoot, '.omx', 'left', 'agent/codex/left');
    const right = addWorktree(repoRoot, '.omc', 'right', 'agent/claude/right');

    writeFileSync(join(left, 'src', 'shared.ts'), 'export const value = "left";\n', 'utf8');
    writeFileSync(join(right, 'src', 'shared.ts'), 'export const value = "right";\n', 'utf8');
    writeFileSync(join(left, 'src', 'left-only.ts'), 'export const leftOnly = true;\n', 'utf8');

    writeActiveSession(repoRoot, {
      branch: 'agent/codex/left',
      fileName: 'left.json',
      sessionKey: 'codex-left',
      worktreePath: left,
    });
    writeActiveSession(repoRoot, {
      branch: 'agent/claude/right',
      fileName: 'right.json',
      sessionKey: 'claude-right',
      worktreePath: right,
    });
    writeFileSync(
      join(repoRoot, '.omx', 'state', 'agent-file-locks.json'),
      `${JSON.stringify(
        {
          locks: {
            'src/left-only.ts': {
              branch: 'agent/codex/left',
              claimed_at: '2026-04-29T11:00:00.000Z',
            },
            'src/right-only.ts': {
              branch: 'agent/claude/right',
              claimed_at: '2026-04-29T11:00:00.000Z',
            },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const report = readWorktreeContentionReport({
      repoRoot,
      now: Date.parse('2026-04-29T12:00:00.000Z'),
    });

    expect(report.inspected_roots).toEqual([
      expect.objectContaining({ id: '.omx/agent-worktrees', exists: true, worktree_count: 1 }),
      expect.objectContaining({ id: '.omc/agent-worktrees', exists: true, worktree_count: 1 }),
    ]);
    expect(report.summary).toMatchObject({
      worktree_count: 2,
      dirty_worktree_count: 2,
      contention_count: 1,
    });
    expect(
      report.worktrees.find((worktree) => worktree.branch === 'agent/codex/left'),
    ).toMatchObject({
      dirty_files: expect.arrayContaining([
        { path: 'src/left-only.ts', status: '??' },
        { path: 'src/shared.ts', status: ' M' },
      ]),
      claimed_files: ['src/left-only.ts'],
      active_session: expect.objectContaining({ session_key: 'codex-left' }),
    });
    expect(report.contentions).toEqual([
      {
        file_path: 'src/shared.ts',
        worktrees: [
          expect.objectContaining({
            branch: 'agent/claude/right',
            dirty_status: ' M',
            active_session_key: 'claude-right',
          }),
          expect.objectContaining({
            branch: 'agent/codex/left',
            dirty_status: ' M',
            active_session_key: 'codex-left',
          }),
        ],
      },
    ]);
  });

  it('resolves a managed worktree path back to the primary repository root', () => {
    const repoRoot = createRepo();
    const worktreePath = addWorktree(repoRoot, '.omx', 'left', 'agent/codex/left');

    expect(resolveManagedRepoRoot(worktreePath)).toBe(repoRoot);
  });
});

function createRepo(): string {
  dir = mkdtempSync(join(tmpdir(), 'colony-worktree-contention-'));
  const repoRoot = join(dir, 'repo');
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  git(['init'], repoRoot);
  git(['config', 'user.email', 'agent@example.test'], repoRoot);
  git(['config', 'user.name', 'Agent'], repoRoot);
  writeFileSync(join(repoRoot, 'src', 'shared.ts'), 'export const value = "base";\n', 'utf8');
  git(['add', 'src/shared.ts'], repoRoot);
  git(['commit', '-m', 'seed'], repoRoot);
  git(['branch', '-M', 'main'], repoRoot);
  return repoRoot;
}

function addWorktree(
  repoRoot: string,
  root: '.omx' | '.omc',
  name: string,
  branch: string,
): string {
  const worktreeRoot = join(repoRoot, root, 'agent-worktrees');
  mkdirSync(worktreeRoot, { recursive: true });
  const worktreePath = join(worktreeRoot, name);
  git(['worktree', 'add', '-b', branch, worktreePath, 'main'], repoRoot);
  return worktreePath;
}

function writeActiveSession(
  repoRoot: string,
  options: { branch: string; fileName: string; sessionKey: string; worktreePath: string },
): void {
  const activeSessionDir = join(repoRoot, '.omx', 'state', 'active-sessions');
  mkdirSync(activeSessionDir, { recursive: true });
  writeFileSync(
    join(activeSessionDir, options.fileName),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repoRoot,
        branch: options.branch,
        taskName: 'worktree contention',
        agentName: 'codex',
        cliName: 'codex',
        sessionKey: options.sessionKey,
        worktreePath: options.worktreePath,
        startedAt: '2026-04-29T11:00:00.000Z',
        lastHeartbeatAt: '2026-04-29T11:05:00.000Z',
        state: 'working',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}
