import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Walk up from `cwd` until we find a `.git` entry. Returns the resolved
 * repository root (the directory containing `.git`) and the current branch,
 * or null if either cannot be determined. Handles both real repos
 * (`.git` is a directory) and worktrees (`.git` is a file pointing to the
 * real gitdir via `gitdir: …`).
 */
export function detectRepoBranch(cwd: string): { repo_root: string; branch: string } | null {
  let dir = resolve(cwd);
  for (let i = 0; i < 40; i++) {
    const dotGit = join(dir, '.git');
    const gitDir = resolveGitDir(dotGit);
    if (gitDir) {
      const branch = readBranch(gitDir);
      if (branch) return { repo_root: dir, branch };
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function resolveGitDir(dotGitPath: string): string | null {
  try {
    const stats = statSync(dotGitPath);
    if (stats.isDirectory()) return dotGitPath;
    if (stats.isFile()) {
      const pointer = readFileSync(dotGitPath, 'utf8');
      const match = pointer.match(/^gitdir:\s*(.+)$/m);
      if (match?.[1]) return resolve(dirname(dotGitPath), match[1].trim());
    }
    return null;
  } catch {
    return null;
  }
}

function readBranch(gitDir: string): string | null {
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    const prefix = 'ref: refs/heads/';
    if (head.startsWith(prefix)) return head.slice(prefix.length);
    // Detached HEAD — no useful branch name for auto-join.
    return null;
  } catch {
    return null;
  }
}
