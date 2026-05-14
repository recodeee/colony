import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export interface RepoFilePathContext {
  repo_root?: string | undefined;
  cwd?: string | undefined;
  file_path: string;
}

export type ClaimPathContext = RepoFilePathContext;

const PSEUDO_CLAIM_PATHS = new Set([
  '/dev/null',
  '/dev/stdin',
  '/dev/stdout',
  '/dev/stderr',
  'NUL',
]);

export function normalizeRepoFilePath(
  repo_root: string | undefined,
  cwd: string | undefined,
  file_path: string,
): string | null;
export function normalizeRepoFilePath(context: RepoFilePathContext): string | null;
export function normalizeRepoFilePath(
  repoRootOrContext: string | RepoFilePathContext | undefined,
  cwd?: string | undefined,
  filePath?: string,
): string | null {
  const context =
    typeof repoRootOrContext === 'object'
      ? repoRootOrContext
      : { repo_root: repoRootOrContext, cwd, file_path: filePath ?? '' };
  const rawPath = context.file_path.trim();
  if (!rawPath || isPseudoClaimPath(rawPath)) return null;
  if (looksLikeDirectoryPath(rawPath)) return null;

  const repoRoot = context.repo_root
    ? realpathWithMissingTail(context.repo_root)
    : context.cwd
      ? realpathWithMissingTail(context.cwd)
      : undefined;
  const cwdRoot = context.cwd ? realpathWithMissingTail(context.cwd) : repoRoot;
  const absolutePath = path.isAbsolute(rawPath)
    ? realpathWithMissingTail(rawPath)
    : cwdRoot
      ? realpathWithMissingTail(path.resolve(relativePathBase(repoRoot, cwdRoot, rawPath), rawPath))
      : undefined;
  if (absolutePath && isExistingDirectoryPath(absolutePath)) return null;

  const relativePath = absolutePath
    ? repoRelativePath({ absolutePath, repoRoot })
    : normalizeRelativePath(rawPath);
  if (relativePath !== null) return stripManagedWorktreePrefix(relativePath);
  if (absolutePath && repoRoot) return null;
  if (absolutePath) return normalizeSlashes(path.normalize(absolutePath));
  return normalizeRelativePath(rawPath);
}

export function normalizeClaimPath(
  repo_root: string | undefined,
  cwd: string | undefined,
  file_path: string,
): string | null;
export function normalizeClaimPath(context: ClaimPathContext): string | null;
export function normalizeClaimPath(
  repoRootOrContext: string | ClaimPathContext | undefined,
  cwd?: string | undefined,
  filePath?: string,
): string | null {
  const context =
    typeof repoRootOrContext === 'object'
      ? repoRootOrContext
      : { repo_root: repoRootOrContext, cwd, file_path: filePath ?? '' };
  return normalizeRepoFilePath(context);
}

/**
 * Discriminated reason for a claim-path rejection, used by callers that want
 * to surface a specific error to the agent instead of the generic "claim path
 * is not claimable". Kept parallel to `normalizeRepoFilePath` so any future
 * rejection branch added there should also be classified here.
 */
export type ClaimPathRejectionReason =
  | 'empty'
  | 'pseudo'
  | 'directory'
  | 'outside_repo'
  | 'unknown';

/**
 * Renders a specific user-facing message for a claim-path rejection so agents
 * see why their input was rejected (directory vs pseudo vs outside-repo vs
 * empty) instead of the generic "not claimable". Lives next to the classifier
 * so any reason added to the enum is forced to grow a message branch too.
 */
export function claimPathRejectionMessage(
  reason: ClaimPathRejectionReason | null,
  file_path: string,
): string {
  switch (reason) {
    case 'directory':
      return `claim path "${file_path}" is a directory; claim individual files inside it instead.`;
    case 'pseudo':
      return `claim path "${file_path}" is a pseudo path (e.g. /dev/null) and cannot be claimed.`;
    case 'outside_repo':
      return `claim path "${file_path}" resolves outside this task's repo_root and cannot be claimed.`;
    case 'empty':
      return 'claim path is empty.';
    default:
      return `claim path is not claimable: ${file_path}`;
  }
}

export function classifyClaimPathRejection(
  context: ClaimPathContext,
): ClaimPathRejectionReason | null {
  const rawPath = context.file_path.trim();
  if (!rawPath) return 'empty';
  if (isPseudoClaimPath(rawPath)) return 'pseudo';
  if (looksLikeDirectoryPath(rawPath)) return 'directory';

  const repoRoot = context.repo_root
    ? realpathWithMissingTail(context.repo_root)
    : context.cwd
      ? realpathWithMissingTail(context.cwd)
      : undefined;
  const cwdRoot = context.cwd ? realpathWithMissingTail(context.cwd) : repoRoot;
  const absolutePath = path.isAbsolute(rawPath)
    ? realpathWithMissingTail(rawPath)
    : cwdRoot
      ? realpathWithMissingTail(path.resolve(relativePathBase(repoRoot, cwdRoot, rawPath), rawPath))
      : undefined;
  if (absolutePath && isExistingDirectoryPath(absolutePath)) return 'directory';

  // The non-null happy path of normalizeRepoFilePath ends at this comment.
  // If we reach here without one of the explicit short-circuits, it means
  // normalize would have either returned a value (so the caller wouldn't be
  // here classifying a rejection) or fallen through. The remaining
  // null-return is "absolutePath was inside repoRoot's filesystem chain but
  // not strictly inside repoRoot itself", which only happens when the path
  // resolves to a sibling worktree/repo — i.e. outside this task's repo_root.
  if (absolutePath && repoRoot) {
    const relativePath = repoRelativePath({ absolutePath, repoRoot });
    if (relativePath === null) return 'outside_repo';
  }

  return 'unknown';
}

function relativePathBase(repoRoot: string | undefined, cwdRoot: string, rawPath: string): string {
  if (!repoRoot) return cwdRoot;
  const cwdRelative = normalizeRelativePath(path.relative(repoRoot, cwdRoot));
  const normalizedRaw = normalizeRelativePath(rawPath);
  if (cwdRelative === '.') return repoRoot;
  if (cwdRelative.startsWith('..')) return normalizedRaw.startsWith('..') ? cwdRoot : repoRoot;
  return normalizedRaw === cwdRelative || normalizedRaw.startsWith(`${cwdRelative}/`)
    ? repoRoot
    : cwdRoot;
}

export function isPseudoClaimPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const normalized = normalizeSlashes(path.normalize(trimmed));
  return PSEUDO_CLAIM_PATHS.has(normalized);
}

function repoRelativePath(args: {
  absolutePath: string;
  repoRoot: string | undefined;
}): string | null {
  const { absolutePath, repoRoot } = args;
  if (!repoRoot) return null;
  const normalizedRepoRoot = path.resolve(repoRoot);

  if (isPathInside(absolutePath, normalizedRepoRoot)) {
    return normalizeRelativePath(path.relative(normalizedRepoRoot, absolutePath));
  }

  const repoGitRoot = findGitRoot(normalizedRepoRoot);
  const repoCommonGitDir = repoGitRoot ? commonGitDir(repoGitRoot) : null;
  const pathGitRoot = findGitRoot(absolutePath);
  if (!repoCommonGitDir || !pathGitRoot) return null;
  const pathCommonGitDir = commonGitDir(pathGitRoot);
  if (!pathCommonGitDir || pathCommonGitDir !== repoCommonGitDir) return null;
  if (!isPathInside(absolutePath, pathGitRoot)) return null;
  return normalizeRelativePath(path.relative(pathGitRoot, absolutePath));
}

function normalizeRelativePath(value: string): string {
  const normalized = normalizeSlashes(path.normalize(value));
  if (normalized === '.') return '.';
  return normalized.replace(/^(\.\/)+/, '');
}

function stripManagedWorktreePrefix(value: string): string {
  const match = value.match(/(^|\/)\.(?:omx|omc)\/agent-worktrees\/[^/]+\/(.*)$/);
  if (!match || match[2] === undefined) return value;
  return match[2] === '' ? '.' : match[2];
}

function isPathInside(child: string, parent: string): boolean {
  const relativePath = path.relative(parent, child);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function looksLikeDirectoryPath(value: string): boolean {
  return value.endsWith('/') || value.endsWith('\\');
}

function isExistingDirectoryPath(value: string): boolean {
  try {
    return existsSync(value) && statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function realpathWithMissingTail(value: string): string {
  const resolved = path.resolve(value);
  const tail: string[] = [];
  let cursor = resolved;

  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return resolved;
    tail.unshift(path.basename(cursor));
    cursor = parent;
  }

  try {
    const base = realpathSync.native(cursor);
    return tail.length > 0 ? path.join(base, ...tail) : base;
  } catch {
    return resolved;
  }
}

function findGitRoot(value: string): string | null {
  let cursor = existingDirectory(value);

  while (true) {
    if (existsSync(path.join(cursor, '.git'))) return realpathWithMissingTail(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function existingDirectory(value: string): string {
  let cursor = path.resolve(value);
  if (existsSync(cursor)) {
    try {
      if (statSync(cursor).isDirectory()) return cursor;
    } catch {
      // Fall through to parent walk.
    }
  }
  cursor = path.dirname(cursor);
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return cursor;
    cursor = parent;
  }
  return cursor;
}

function commonGitDir(gitRoot: string): string | null {
  const dotGit = path.join(gitRoot, '.git');
  if (!existsSync(dotGit)) return null;
  try {
    const stat = statSync(dotGit);
    if (stat.isDirectory()) return realpathSync.native(dotGit);
    const content = readFileSync(dotGit, 'utf8').trim();
    const match = content.match(/^gitdir:\s*(.+)$/i);
    if (!match?.[1]) return null;
    const gitDir = path.isAbsolute(match[1]) ? match[1] : path.resolve(gitRoot, match[1]);
    const normalized = realpathWithMissingTail(gitDir);
    const marker = `${path.sep}worktrees${path.sep}`;
    const index = normalized.indexOf(marker);
    return index >= 0 ? normalized.slice(0, index) : normalized;
  } catch {
    return null;
  }
}

function normalizeSlashes(value: string): string {
  return value.replaceAll(path.sep, '/');
}
