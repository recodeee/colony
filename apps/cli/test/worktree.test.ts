import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import kleur from 'kleur';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../src/index.js';

let dir = '';
let repoRoot = '';
let output = '';

beforeEach(() => {
  kleur.enabled = false;
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
  repoRoot = '';
  kleur.enabled = true;
});

describe('colony worktree CLI', () => {
  it('emits JSON for same-file dirty contention in temp git worktrees', async () => {
    repoRoot = createRepo();
    const left = addWorktree(repoRoot, '.omx', 'left', 'agent/codex/left');
    const right = addWorktree(repoRoot, '.omc', 'right', 'agent/codex/right');
    writeFileSync(join(left, 'src', 'shared.ts'), 'export const value = "left";\n', 'utf8');
    writeFileSync(join(right, 'src', 'shared.ts'), 'export const value = "right";\n', 'utf8');

    await createProgram().parseAsync(
      ['node', 'test', 'worktree', 'contention', '--repo-root', repoRoot, '--json'],
      { from: 'node' },
    );

    const json = JSON.parse(output) as {
      summary: { worktree_count: number; contention_count: number };
      contentions: Array<{ file_path: string; worktrees: Array<{ branch: string }> }>;
    };
    expect(json.summary).toMatchObject({ worktree_count: 2, contention_count: 1 });
    expect(json.contentions).toEqual([
      {
        file_path: 'src/shared.ts',
        worktrees: [
          expect.objectContaining({ branch: 'agent/codex/left' }),
          expect.objectContaining({ branch: 'agent/codex/right' }),
        ],
      },
    ]);
  });

  it('renders a compact human contention report', async () => {
    repoRoot = createRepo();
    const left = addWorktree(repoRoot, '.omx', 'left', 'agent/codex/left');
    const right = addWorktree(repoRoot, '.omx', 'right', 'agent/codex/right');
    writeFileSync(join(left, 'src', 'shared.ts'), 'export const value = "left";\n', 'utf8');
    writeFileSync(join(right, 'src', 'shared.ts'), 'export const value = "right";\n', 'utf8');

    await createProgram().parseAsync(
      ['node', 'test', 'worktree', 'contention', '--repo-root', repoRoot],
      { from: 'node' },
    );

    expect(output).toContain('Worktree contention');
    expect(output).toContain('contentions: 1');
    expect(output).toContain('src/shared.ts');
    expect(output).toContain('agent/codex/left');
    expect(output).toContain('agent/codex/right');
  });
});

function createRepo(): string {
  dir = mkdtempSync(join(tmpdir(), 'colony-cli-worktree-contention-'));
  const root = join(dir, 'repo');
  mkdirSync(join(root, 'src'), { recursive: true });
  git(['init'], root);
  git(['config', 'user.email', 'agent@example.test'], root);
  git(['config', 'user.name', 'Agent'], root);
  writeFileSync(join(root, 'src', 'shared.ts'), 'export const value = "base";\n', 'utf8');
  git(['add', 'src/shared.ts'], root);
  git(['commit', '-m', 'seed'], root);
  git(['branch', '-M', 'main'], root);
  return root;
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

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}
