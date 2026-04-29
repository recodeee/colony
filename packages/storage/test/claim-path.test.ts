import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeClaimPath, normalizeRepoFilePath } from '../src/index.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-claim-path-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function repoFixture(): { repoRoot: string; worktreeRoot: string } {
  const repoRoot = join(dir, 'repo');
  const worktreeRoot = join(dir, 'worktree');
  mkdirSync(join(repoRoot, '.git', 'worktrees', 'worktree'), { recursive: true });
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  mkdirSync(join(worktreeRoot, 'src'), { recursive: true });
  writeFileSync(
    join(worktreeRoot, '.git'),
    `gitdir: ${join(repoRoot, '.git', 'worktrees', 'worktree')}\n`,
  );
  return { repoRoot, worktreeRoot };
}

describe('normalizeRepoFilePath', () => {
  it('normalizes absolute repo paths to repo-relative paths', () => {
    const { repoRoot } = repoFixture();

    expect(
      normalizeRepoFilePath({
        repo_root: repoRoot,
        cwd: repoRoot,
        file_path: join(repoRoot, 'src/x.ts'),
      }),
    ).toBe('src/x.ts');
  });

  it('normalizes worktree paths to the same repo-relative path', () => {
    const { repoRoot, worktreeRoot } = repoFixture();

    expect(
      normalizeRepoFilePath({
        repo_root: repoRoot,
        cwd: worktreeRoot,
        file_path: join(worktreeRoot, 'src/x.ts'),
      }),
    ).toBe('src/x.ts');
  });

  it('removes leading dot segments from relative paths', () => {
    const { repoRoot } = repoFixture();

    expect(normalizeRepoFilePath(repoRoot, repoRoot, './src/x.ts')).toBe('src/x.ts');
  });

  it('resolves relative paths from nested cwd to repo-relative paths', () => {
    const { repoRoot } = repoFixture();
    const cwd = join(repoRoot, 'packages', 'storage');
    mkdirSync(cwd, { recursive: true });

    expect(normalizeRepoFilePath(repoRoot, cwd, '../../src/x.ts')).toBe('src/x.ts');
  });

  it('keeps already repo-relative paths stable from nested cwd', () => {
    const { repoRoot } = repoFixture();
    const cwd = join(repoRoot, 'packages', 'storage');
    mkdirSync(cwd, { recursive: true });

    expect(normalizeRepoFilePath(repoRoot, cwd, 'packages/storage/src/x.ts')).toBe(
      'packages/storage/src/x.ts',
    );
  });

  it('treats relative paths as repo-relative when metadata cwd is a sibling worktree', () => {
    const { repoRoot } = repoFixture();
    const metadataWorktree = join(dir, 'missing-worktree');

    expect(normalizeRepoFilePath(repoRoot, metadataWorktree, 'src/bridge.ts')).toBe(
      'src/bridge.ts',
    );
  });

  it('collapses duplicate slashes in relative paths', () => {
    const { repoRoot } = repoFixture();

    expect(normalizeRepoFilePath(repoRoot, repoRoot, './src//nested///x.ts')).toBe(
      'src/nested/x.ts',
    );
  });

  it('skips pseudo paths instead of turning them into repo files', () => {
    const { repoRoot } = repoFixture();

    expect(normalizeRepoFilePath(repoRoot, repoRoot, '/dev/null')).toBeNull();
  });

  it('keeps normalizeClaimPath as the compatibility alias', () => {
    const { repoRoot } = repoFixture();

    expect(normalizeClaimPath(repoRoot, repoRoot, './src/x.ts')).toBe('src/x.ts');
  });
});
