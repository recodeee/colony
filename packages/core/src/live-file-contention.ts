import { posix, resolve } from 'node:path';
import type { TaskClaimRow, TaskRow } from '@colony/storage';
import { classifyClaimAge } from './claim-age.js';
import { type HivemindSession, readActiveOmxSessions } from './hivemind.js';
import { inferIdeFromSessionId } from './infer-ide.js';
import type { MemoryStore } from './memory-store.js';

const ALL_TASKS_LIMIT = 1_000_000;

export interface LiveFileContentionWarning {
  code: 'LIVE_FILE_CONTENTION';
  owner_session_id: string;
  owner_agent: string;
  owner_branch: string;
  owner_task_id: number;
  file_path: string;
  last_seen: string;
}

export interface LiveFileContentionOptions {
  now?: number;
  claim_stale_minutes?: number;
  repo_root?: string;
  repo_roots?: string[];
  task_id?: number;
  task_ids?: number[];
  assume_requester_live?: boolean;
}

export function normalizeClaimFilePath(filePath: string): string {
  const cleaned = filePath.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!cleaned) return '';
  const normalized = posix.normalize(cleaned);
  return normalized === '.' ? '' : normalized.replace(/^\.\//, '');
}

export function liveFileContentionsForClaim(
  store: MemoryStore,
  args: {
    session_id: string;
    file_path: string;
    task_id?: number;
  } & LiveFileContentionOptions,
): LiveFileContentionWarning[] {
  const normalizedPath = normalizeClaimFilePath(args.file_path);
  if (!normalizedPath) return [];

  const tasks = scopedTasks(store, args);
  if (tasks.length === 0) return [];

  const repoRoots = repoRootsForTasks(tasks, args);
  const liveSessions = liveSessionMap(repoRoots, args.now);
  const requesterIsLive = args.assume_requester_live ?? liveSessions.has(args.session_id);
  if (!requesterIsLive) return [];

  const byTaskId = new Map(tasks.map((task) => [task.id, task]));
  const warnings: LiveFileContentionWarning[] = [];
  const seen = new Set<string>();

  for (const task of tasks) {
    for (const claim of store.storage.listClaims(task.id)) {
      if (claim.session_id === args.session_id) continue;
      if (normalizeClaimFilePath(claim.file_path) !== normalizedPath) continue;
      const warning = warningForClaim(store, claim, byTaskId, liveSessions, normalizedPath, args);
      if (!warning) continue;
      const key = `${warning.owner_task_id}:${warning.owner_session_id}:${warning.file_path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      warnings.push(warning);
    }
  }

  return warnings.sort(compareWarnings);
}

export interface LiveFileContentionGroup {
  task_id: number;
  branch: string | null;
  repo_root: string;
  file_path: string;
  claimers: Array<{
    session_id: string;
    agent: string;
    branch: string;
    last_seen: string;
    claimed_at: number;
  }>;
}

/**
 * Surface every file with two or more concurrent strong claims, regardless of
 * which session is requesting. Used by `colony lane contentions` so operators
 * can see — and act on — competing claims without first knowing one of the
 * session ids. Claims whose owner is not in the live OMX session table are
 * skipped (they would not show up as a live contention to any agent either).
 */
export function listLiveFileContentions(
  store: MemoryStore,
  options: LiveFileContentionOptions = {},
): LiveFileContentionGroup[] {
  const tasks = scopedTasks(store, options);
  if (tasks.length === 0) return [];
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const repoRoots = repoRootsForTasks(tasks, options);
  const liveSessions = liveSessionMap(repoRoots, options.now);
  const claimWindowMinutes = options.claim_stale_minutes ?? store.settings.claimStaleMinutes;
  const now = options.now ?? Date.now();

  const grouped = new Map<string, LiveFileContentionGroup>();
  for (const task of tasks) {
    for (const claim of store.storage.listClaims(task.id)) {
      const normalizedPath = normalizeClaimFilePath(claim.file_path);
      if (!normalizedPath) continue;
      const age = classifyClaimAge(claim, { now, claim_stale_minutes: claimWindowMinutes });
      if (age.ownership_strength !== 'strong') continue;
      const ownerSession = liveSessions.get(claim.session_id);
      if (!ownerSession) continue;
      const key = `${task.id}|${normalizedPath}`;
      let group = grouped.get(key);
      if (!group) {
        group = {
          task_id: task.id,
          branch: task.branch,
          repo_root: task.repo_root,
          file_path: normalizedPath,
          claimers: [],
        };
        grouped.set(key, group);
      }
      const ownerAgent =
        concreteAgent(ownerSession.agent) ??
        store.storage.getParticipantAgent(task.id, claim.session_id) ??
        inferIdeFromSessionId(claim.session_id) ??
        'agent';
      group.claimers.push({
        session_id: claim.session_id,
        agent: ownerAgent,
        branch: ownerSession.branch || tasksById.get(claim.task_id)?.branch || '',
        last_seen: ownerSession.last_heartbeat_at || ownerSession.updated_at,
        claimed_at: claim.claimed_at,
      });
    }
  }

  const out: LiveFileContentionGroup[] = [];
  for (const group of grouped.values()) {
    if (group.claimers.length < 2) continue;
    group.claimers.sort((a, b) => b.claimed_at - a.claimed_at);
    out.push(group);
  }
  out.sort((a, b) => a.task_id - b.task_id || a.file_path.localeCompare(b.file_path));
  return out;
}

export function liveFileContentionsForSessionClaims(
  store: MemoryStore,
  args: {
    session_id: string;
  } & LiveFileContentionOptions,
): LiveFileContentionWarning[] {
  const now = args.now ?? Date.now();
  const tasks = scopedTasks(store, args);
  const currentClaims: TaskClaimRow[] = [];

  for (const task of tasks) {
    for (const claim of store.storage.listClaims(task.id)) {
      if (claim.session_id !== args.session_id) continue;
      const age = classifyClaimAge(claim, {
        now,
        claim_stale_minutes: args.claim_stale_minutes ?? store.settings.claimStaleMinutes,
      });
      if (age.ownership_strength !== 'strong') continue;
      currentClaims.push(claim);
    }
  }

  const warnings: LiveFileContentionWarning[] = [];
  const seen = new Set<string>();
  const scanArgs = { ...args };
  delete scanArgs.task_ids;
  for (const claim of currentClaims) {
    for (const warning of liveFileContentionsForClaim(store, {
      ...scanArgs,
      file_path: claim.file_path,
      task_id: claim.task_id,
      assume_requester_live: args.assume_requester_live ?? true,
    })) {
      const key = `${warning.owner_task_id}:${warning.owner_session_id}:${warning.file_path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      warnings.push(warning);
    }
  }

  return warnings.sort(compareWarnings);
}

function warningForClaim(
  store: MemoryStore,
  claim: TaskClaimRow,
  tasksById: Map<number, TaskRow>,
  liveSessions: Map<string, HivemindSession>,
  normalizedPath: string,
  options: LiveFileContentionOptions,
): LiveFileContentionWarning | null {
  const now = options.now ?? Date.now();
  const age = classifyClaimAge(claim, {
    now,
    claim_stale_minutes: options.claim_stale_minutes ?? store.settings.claimStaleMinutes,
  });
  if (age.ownership_strength !== 'strong') return null;

  const ownerSession = liveSessions.get(claim.session_id);
  if (!ownerSession) return null;
  const task = tasksById.get(claim.task_id);

  return {
    code: 'LIVE_FILE_CONTENTION',
    owner_session_id: claim.session_id,
    owner_agent:
      concreteAgent(ownerSession.agent) ??
      (task ? store.storage.getParticipantAgent(task.id, claim.session_id) : undefined) ??
      inferIdeFromSessionId(claim.session_id) ??
      'agent',
    owner_branch: ownerSession.branch || task?.branch || '',
    owner_task_id: claim.task_id,
    file_path: normalizedPath,
    last_seen: ownerSession.last_heartbeat_at || ownerSession.updated_at,
  };
}

function scopedTasks(store: MemoryStore, options: LiveFileContentionOptions): TaskRow[] {
  let allTasks: TaskRow[];
  try {
    allTasks = store.storage.listTasks(ALL_TASKS_LIMIT);
  } catch {
    return [];
  }
  const taskIdSet =
    options.task_ids && options.task_ids.length > 0 ? new Set(options.task_ids) : null;
  const requestedRoots = requestedRepoRoots(options);
  const rootTaskId =
    options.task_id ??
    (options.task_ids && options.task_ids.length === 1 ? options.task_ids[0] : undefined);
  const taskScopedRoot = allTasks.find((task) => task.id === rootTaskId)?.repo_root;
  const roots =
    requestedRoots.size > 0
      ? requestedRoots
      : taskScopedRoot
        ? new Set([normalizeRepoRoot(taskScopedRoot)])
        : null;

  return allTasks.filter((task) => {
    if (taskIdSet && !taskIdSet.has(task.id)) return false;
    if (roots && !roots.has(normalizeRepoRoot(task.repo_root))) return false;
    return true;
  });
}

function requestedRepoRoots(options: LiveFileContentionOptions): Set<string> {
  return new Set(
    [options.repo_root, ...(options.repo_roots ?? [])]
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map(normalizeRepoRoot),
  );
}

function repoRootsForTasks(tasks: TaskRow[], options: LiveFileContentionOptions): string[] {
  const requested = requestedRepoRoots(options);
  const roots = requested.size > 0 ? requested : new Set(tasks.map((task) => task.repo_root));
  return [...roots].map(normalizeRepoRoot);
}

function liveSessionMap(
  repoRoots: string[],
  now: number | undefined,
): Map<string, HivemindSession> {
  const sessions = readActiveOmxSessions({
    repoRoots,
    ...(now !== undefined ? { now } : {}),
  });
  const bySession = new Map<string, HivemindSession>();
  for (const session of sessions) {
    if (!session.session_key) continue;
    bySession.set(session.session_key, session);
  }
  return bySession;
}

function normalizeRepoRoot(repoRoot: string): string {
  return resolve(repoRoot);
}

function concreteAgent(agent: string): string | undefined {
  return agent && agent !== 'agent' && agent !== 'unknown' ? agent : undefined;
}

function compareWarnings(
  left: LiveFileContentionWarning,
  right: LiveFileContentionWarning,
): number {
  const rightSeen = Date.parse(right.last_seen);
  const leftSeen = Date.parse(left.last_seen);
  if (Number.isFinite(rightSeen) && Number.isFinite(leftSeen) && rightSeen !== leftSeen) {
    return rightSeen - leftSeen;
  }
  if (left.owner_task_id !== right.owner_task_id) return left.owner_task_id - right.owner_task_id;
  return left.owner_session_id.localeCompare(right.owner_session_id);
}
