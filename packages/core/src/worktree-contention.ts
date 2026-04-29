import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const MANAGED_WORKTREE_ROOTS = [
  { id: '.omx/agent-worktrees', relativePath: join('.omx', 'agent-worktrees') },
  { id: '.omc/agent-worktrees', relativePath: join('.omc', 'agent-worktrees') },
] as const;

const ACTIVE_SESSION_DIRS = [
  { source: 'omx-active-session', relativePath: join('.omx', 'state', 'active-sessions') },
  { source: 'omc-session', relativePath: join('.omc', 'sessions') },
] as const;

const FILE_LOCK_PATHS = [
  join('.omx', 'state', 'agent-file-locks.json'),
  join('.omc', 'state', 'agent-file-locks.json'),
] as const;

export interface WorktreeContentionOptions {
  repoRoot?: string;
  now?: number;
}

export interface WorktreeInspectionRoot {
  id: string;
  path: string;
  exists: boolean;
  worktree_count: number;
}

export interface WorktreeDirtyFile {
  path: string;
  status: string;
}

export interface WorktreeActiveSession {
  session_key: string;
  source: 'omx-active-session' | 'omc-session';
  branch: string;
  worktree_path: string;
  task: string;
  agent: string;
  state: string;
  started_at: string;
  last_heartbeat_at: string;
  updated_at: string;
  file_path: string;
}

export interface ManagedWorktreeInspection {
  branch: string;
  path: string;
  managed_root: string;
  dirty_files: WorktreeDirtyFile[];
  claimed_files: string[];
  active_session: WorktreeActiveSession | null;
}

export interface WorktreeContentionParticipant {
  branch: string;
  path: string;
  managed_root: string;
  dirty_status: string;
  claimed: boolean;
  active_session_key: string | null;
}

export interface WorktreeDirtyContention {
  file_path: string;
  worktrees: WorktreeContentionParticipant[];
}

export interface WorktreeContentionReport {
  generated_at: string;
  repo_root: string;
  inspected_roots: WorktreeInspectionRoot[];
  worktrees: ManagedWorktreeInspection[];
  contentions: WorktreeDirtyContention[];
  summary: {
    worktree_count: number;
    dirty_worktree_count: number;
    dirty_file_count: number;
    contention_count: number;
  };
}

type JsonRecord = Record<string, unknown>;

export function readWorktreeContentionReport(
  options: WorktreeContentionOptions = {},
): WorktreeContentionReport {
  const now = options.now ?? Date.now();
  const repoRoot = resolveManagedRepoRoot(options.repoRoot ?? process.cwd());
  const sessions = readActiveSessions(repoRoot);
  const claimsByBranch = readClaimedFilesByBranch(repoRoot);
  const inspectedRoots: WorktreeInspectionRoot[] = [];
  const worktrees: ManagedWorktreeInspection[] = [];

  for (const root of MANAGED_WORKTREE_ROOTS) {
    const rootPath = join(repoRoot, root.relativePath);
    const rootWorktrees = inspectManagedRoot({
      rootId: root.id,
      rootPath,
      sessions,
      claimsByBranch,
    });
    inspectedRoots.push({
      id: root.id,
      path: rootPath,
      exists: existsSync(rootPath),
      worktree_count: rootWorktrees.length,
    });
    worktrees.push(...rootWorktrees);
  }

  const sortedWorktrees = worktrees.sort(compareWorktrees);
  const contentions = detectDirtyContentions(sortedWorktrees);
  const dirtyFileCount = sortedWorktrees.reduce(
    (count, worktree) => count + worktree.dirty_files.length,
    0,
  );

  return {
    generated_at: new Date(now).toISOString(),
    repo_root: repoRoot,
    inspected_roots: inspectedRoots,
    worktrees: sortedWorktrees,
    contentions,
    summary: {
      worktree_count: sortedWorktrees.length,
      dirty_worktree_count: sortedWorktrees.filter((worktree) => worktree.dirty_files.length > 0)
        .length,
      dirty_file_count: dirtyFileCount,
      contention_count: contentions.length,
    },
  };
}

export function resolveManagedRepoRoot(path: string): string {
  const resolved = resolve(path);
  const normalized = resolved.replace(/\\/g, '/');
  for (const marker of ['/.omx/agent-worktrees/', '/.omc/agent-worktrees/']) {
    const markerIndex = normalized.indexOf(marker);
    if (markerIndex > 0) {
      return resolve(normalized.slice(0, markerIndex));
    }
  }
  return resolved;
}

function inspectManagedRoot(args: {
  rootId: string;
  rootPath: string;
  sessions: WorktreeActiveSession[];
  claimsByBranch: Map<string, string[]>;
}): ManagedWorktreeInspection[] {
  if (!existsSync(args.rootPath)) return [];

  const worktrees: ManagedWorktreeInspection[] = [];
  for (const entry of safeReadDir(args.rootPath)) {
    if (!entry.isDirectory()) continue;

    const worktreePath = join(args.rootPath, entry.name);
    if (!isGitWorktree(worktreePath)) continue;

    const branch = readWorktreeBranch(worktreePath);
    if (!branch) continue;

    const dirtyFiles = readDirtyFiles(worktreePath);
    const claimedFiles = args.claimsByBranch.get(branch) ?? [];
    worktrees.push({
      branch,
      path: resolve(worktreePath),
      managed_root: args.rootId,
      dirty_files: dirtyFiles,
      claimed_files: claimedFiles,
      active_session: findActiveSession(args.sessions, branch, worktreePath),
    });
  }

  return worktrees;
}

function isGitWorktree(worktreePath: string): boolean {
  const topLevel = gitText(['rev-parse', '--show-toplevel'], worktreePath);
  return topLevel !== null && resolve(topLevel) === resolve(worktreePath);
}

function readWorktreeBranch(worktreePath: string): string {
  const branch = gitText(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
  if (branch && branch !== 'HEAD') return branch;
  const head = gitText(['rev-parse', '--short', 'HEAD'], worktreePath);
  return head ? `HEAD@${head}` : '';
}

function readDirtyFiles(worktreePath: string): WorktreeDirtyFile[] {
  const output = gitBuffer(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    worktreePath,
  );
  if (!output || output.length === 0) return [];

  const seen = new Map<string, WorktreeDirtyFile>();
  const entries = output.toString('utf8').split('\0').filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.length < 4) continue;

    const status = entry.slice(0, 2);
    const filePath = normalizeFilePath(entry.slice(3));
    if (filePath) {
      seen.set(filePath, { path: filePath, status });
    }

    if (status.includes('R') || status.includes('C')) {
      index += 1;
    }
  }

  return [...seen.values()].sort(compareDirtyFiles);
}

function detectDirtyContentions(worktrees: ManagedWorktreeInspection[]): WorktreeDirtyContention[] {
  const byPath = new Map<string, WorktreeContentionParticipant[]>();

  for (const worktree of worktrees) {
    const claimed = new Set(worktree.claimed_files);
    for (const dirtyFile of worktree.dirty_files) {
      const entries = byPath.get(dirtyFile.path) ?? [];
      entries.push({
        branch: worktree.branch,
        path: worktree.path,
        managed_root: worktree.managed_root,
        dirty_status: dirtyFile.status,
        claimed: claimed.has(dirtyFile.path),
        active_session_key: worktree.active_session?.session_key ?? null,
      });
      byPath.set(dirtyFile.path, entries);
    }
  }

  return [...byPath.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([filePath, entries]) => ({
      file_path: filePath,
      worktrees: entries.sort(compareContentionParticipants),
    }))
    .sort((left, right) => left.file_path.localeCompare(right.file_path));
}

function readActiveSessions(repoRoot: string): WorktreeActiveSession[] {
  const sessions: WorktreeActiveSession[] = [];

  for (const location of ACTIVE_SESSION_DIRS) {
    const dir = join(repoRoot, location.relativePath);
    for (const filePath of listJsonFiles(dir)) {
      const input = readJsonFile(filePath);
      if (!input) continue;
      if (location.source === 'omc-session' && readString(input.ended_at)) continue;

      const sessionKey =
        readString(input.sessionKey) ||
        readString(input.session_key) ||
        readString(input.session_id) ||
        basename(filePath, '.json');
      const worktreePath =
        readString(input.worktreePath) || readString(input.worktree_path) || readString(input.cwd);
      if (!sessionKey || !worktreePath) continue;

      const task =
        readString(input.latestTaskPreview) ||
        readString(input.latest_task_preview) ||
        readString(input.taskName) ||
        readString(input.task_name);
      const startedAt = normalizeIso(readString(input.startedAt) || readString(input.started_at));
      const lastHeartbeatAt = normalizeIso(
        readString(input.lastHeartbeatAt) || readString(input.last_heartbeat_at),
      );
      const updatedAt =
        lastHeartbeatAt ||
        normalizeIso(readString(input.updatedAt) || readString(input.updated_at));

      sessions.push({
        session_key: sessionKey,
        source: location.source,
        branch: readString(input.branch),
        worktree_path: resolve(worktreePath),
        task,
        agent:
          readString(input.agentName) || readString(input.agent_name) || readString(input.agent),
        state: readString(input.state),
        started_at: startedAt,
        last_heartbeat_at: lastHeartbeatAt,
        updated_at: updatedAt,
        file_path: filePath,
      });
    }
  }

  return sessions.sort(compareSessionsDesc);
}

function readClaimedFilesByBranch(repoRoot: string): Map<string, string[]> {
  const byBranch = new Map<string, Set<string>>();

  for (const relativePath of FILE_LOCK_PATHS) {
    const payload = readJsonFile(join(repoRoot, relativePath));
    if (!payload || !isRecord(payload.locks)) continue;

    for (const [filePath, value] of Object.entries(payload.locks)) {
      if (!isRecord(value)) continue;
      const branch = readString(value.branch);
      const normalizedPath = normalizeFilePath(filePath);
      if (!branch || !normalizedPath) continue;
      const files = byBranch.get(branch) ?? new Set<string>();
      files.add(normalizedPath);
      byBranch.set(branch, files);
    }
  }

  return new Map(
    [...byBranch.entries()].map(([branch, files]) => [
      branch,
      [...files].sort((left, right) => left.localeCompare(right)),
    ]),
  );
}

function findActiveSession(
  sessions: WorktreeActiveSession[],
  branch: string,
  worktreePath: string,
): WorktreeActiveSession | null {
  const resolvedWorktreePath = resolve(worktreePath);
  return (
    sessions.find((session) => resolve(session.worktree_path) === resolvedWorktreePath) ??
    sessions.find((session) => session.branch === branch) ??
    null
  );
}

function safeReadDir(path: string): Dirent<string>[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function listJsonFiles(dir: string): string[] {
  return safeReadDir(dir)
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(dir, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function readJsonFile(path: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function gitText(args: string[], cwd: string): string | null {
  const output = gitBuffer(args, cwd);
  return output ? output.toString('utf8').trim() : null;
}

function gitBuffer(args: string[], cwd: string): Buffer | null {
  try {
    return execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function normalizeFilePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function normalizeIso(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareWorktrees(
  left: ManagedWorktreeInspection,
  right: ManagedWorktreeInspection,
): number {
  return left.branch.localeCompare(right.branch) || left.path.localeCompare(right.path);
}

function compareDirtyFiles(left: WorktreeDirtyFile, right: WorktreeDirtyFile): number {
  return left.path.localeCompare(right.path) || left.status.localeCompare(right.status);
}

function compareContentionParticipants(
  left: WorktreeContentionParticipant,
  right: WorktreeContentionParticipant,
): number {
  return left.branch.localeCompare(right.branch) || left.path.localeCompare(right.path);
}

function compareSessionsDesc(left: WorktreeActiveSession, right: WorktreeActiveSession): number {
  const leftTime = Date.parse(left.updated_at || left.last_heartbeat_at || left.started_at);
  const rightTime = Date.parse(right.updated_at || right.last_heartbeat_at || right.started_at);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return left.session_key.localeCompare(right.session_key);
}
