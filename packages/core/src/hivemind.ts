import { type Dirent, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, delimiter, join, resolve } from 'node:path';

const ACTIVE_SESSIONS_RELATIVE_DIR = join('.omx', 'state', 'active-sessions');
const FILE_LOCKS_RELATIVE_PATH = join('.omx', 'state', 'agent-file-locks.json');
const MANAGED_WORKTREE_ROOTS = [join('.omx', 'agent-worktrees'), join('.omc', 'agent-worktrees')];
const HEARTBEAT_STALE_MS = 5 * 60 * 1000;
const WORKTREE_LOCK_STALE_MS = 15 * 60 * 1000;
const FILE_LOCK_STALE_MS = 60 * 60 * 1000;
const FILE_LOCK_PREVIEW_LIMIT = 5;
const DEFAULT_LIMIT = 50;

export type HivemindActivity = 'working' | 'thinking' | 'idle' | 'stalled' | 'dead' | 'unknown';

export interface HivemindOptions {
  repoRoot?: string;
  repoRoots?: string[];
  includeStale?: boolean;
  limit?: number;
  now?: number;
}

export interface HivemindSession {
  repo_root: string;
  source: 'active-session' | 'worktree-lock' | 'file-lock';
  branch: string;
  task: string;
  task_name: string;
  latest_task_preview: string;
  agent: string;
  cli: string;
  state: string;
  activity: HivemindActivity;
  activity_summary: string;
  worktree_path: string;
  pid: number | null;
  pid_alive: boolean | null;
  started_at: string;
  last_heartbeat_at: string;
  updated_at: string;
  elapsed_seconds: number;
  task_mode: string;
  openspec_tier: string;
  routing_reason: string;
  snapshot_name: string;
  project_name: string;
  session_key: string;
  locked_file_count: number;
  locked_file_preview: string[];
  file_path: string;
}

export interface HivemindSnapshot {
  generated_at: string;
  repo_roots: string[];
  session_count: number;
  counts: Record<HivemindActivity, number>;
  sessions: HivemindSession[];
}

type JsonRecord = Record<string, unknown>;

interface FileLockClaim {
  filePath: string;
  branch: string;
  claimedAt: string;
}

interface FileLockGroup {
  branch: string;
  claims: FileLockClaim[];
  latestClaimedAt: string;
  earliestClaimedAt: string;
  preview: string[];
  worktreePath: string;
  filePath: string;
}

export function readHivemind(options: HivemindOptions = {}): HivemindSnapshot {
  const now = options.now ?? Date.now();
  const repoRoots = resolveRepoRoots(options);
  const limit = normalizeLimit(options.limit);
  const sessions = repoRoots.flatMap((repoRoot) => readRepoSessions(repoRoot, now));
  const visibleSessions = options.includeStale
    ? sessions
    : sessions.filter((session) => session.activity !== 'dead');
  const sortedSessions = visibleSessions.sort(compareSessions);
  const limitedSessions = sortedSessions.slice(0, limit);

  return {
    generated_at: new Date(now).toISOString(),
    repo_roots: repoRoots,
    session_count: sortedSessions.length,
    counts: countActivities(sortedSessions),
    sessions: limitedSessions,
  };
}

function resolveRepoRoots(options: HivemindOptions): string[] {
  const roots = [options.repoRoot, ...(options.repoRoots ?? []), ...envRepoRoots()]
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);

  const selectedRoots = roots.length > 0 ? roots : [process.cwd()];
  return [...new Set(selectedRoots.map((entry) => resolve(entry)))];
}

function envRepoRoots(): string[] {
  const raw = process.env.CAVEMEM_HIVEMIND_REPO_ROOTS;
  if (!raw) return [];
  return raw.split(delimiter);
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isInteger(limit) || !limit || limit <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(limit, 100);
}

function readRepoSessions(repoRoot: string, now: number): HivemindSession[] {
  const activeSessions = readActiveSessionFiles(repoRoot, now);
  const activeWorktrees = new Set(
    activeSessions
      .filter((session) => session.activity !== 'dead')
      .map((session) => resolve(session.worktree_path))
      .filter(Boolean),
  );
  const lockSessions = readWorktreeLockSessions(repoRoot, now).filter(
    (session) => !activeWorktrees.has(resolve(session.worktree_path)),
  );

  return mergeFileLockSessions(repoRoot, [...activeSessions, ...lockSessions], now);
}

function readActiveSessionFiles(repoRoot: string, now: number): HivemindSession[] {
  const activeSessionsDir = join(repoRoot, ACTIVE_SESSIONS_RELATIVE_DIR);
  const files = listJsonFiles(activeSessionsDir);
  const sessions: HivemindSession[] = [];

  for (const filePath of files) {
    const parsed = readJsonFile(filePath);
    const session = parsed ? normalizeActiveSession(repoRoot, parsed, filePath, now) : null;
    if (session) sessions.push(session);
  }

  return sessions;
}

function normalizeActiveSession(
  fallbackRepoRoot: string,
  input: JsonRecord,
  filePath: string,
  now: number,
): HivemindSession | null {
  const repoRoot = resolve(
    readString(input.repoRoot) || readString(input.repo_root) || fallbackRepoRoot,
  );
  const branch = readString(input.branch);
  const worktreePath = readString(input.worktreePath) || readString(input.worktree_path);
  const taskName = readString(input.taskName) || readString(input.task_name) || 'task';
  const startedAt = normalizeIso(readString(input.startedAt) || readString(input.started_at));
  const lastHeartbeatAt = normalizeIso(
    readString(input.lastHeartbeatAt) || readString(input.last_heartbeat_at) || startedAt,
  );
  const pid = readPositiveInteger(input.pid);

  if (!branch || !worktreePath || !startedAt) {
    return null;
  }

  const pidAlive = pid === null ? null : isPidAlive(pid);
  const state = normalizeState(readString(input.state));
  const activity = classifyActiveSession({ state, lastHeartbeatAt, pidAlive, now });
  const latestTaskPreview =
    readString(input.latestTaskPreview) || readString(input.latest_task_preview);

  return {
    repo_root: repoRoot,
    source: 'active-session',
    branch,
    task: latestTaskPreview || taskName,
    task_name: taskName,
    latest_task_preview: latestTaskPreview,
    agent: readString(input.agentName) || readString(input.agent_name) || 'agent',
    cli: readString(input.cliName) || readString(input.cli_name) || 'codex',
    state,
    activity,
    activity_summary: activeActivitySummary(activity, state, lastHeartbeatAt, pidAlive, now),
    worktree_path: resolve(worktreePath),
    pid,
    pid_alive: pidAlive,
    started_at: startedAt,
    last_heartbeat_at: lastHeartbeatAt,
    updated_at: lastHeartbeatAt || startedAt,
    elapsed_seconds: elapsedSeconds(startedAt, now),
    task_mode: readString(input.taskMode) || readString(input.task_mode),
    openspec_tier: readString(input.openspecTier) || readString(input.openspec_tier),
    routing_reason: readString(input.taskRoutingReason) || readString(input.routing_reason),
    snapshot_name: '',
    project_name: '',
    session_key: readString(input.sessionKey) || readString(input.session_key),
    locked_file_count: 0,
    locked_file_preview: [],
    file_path: filePath,
  };
}

function readWorktreeLockSessions(repoRoot: string, now: number): HivemindSession[] {
  const sessions: HivemindSession[] = [];
  for (const relativeRoot of MANAGED_WORKTREE_ROOTS) {
    const managedRoot = join(repoRoot, relativeRoot);
    if (!existsSync(managedRoot)) continue;

    for (const entry of safeReadDir(managedRoot)) {
      if (!entry.isDirectory()) continue;
      const worktreePath = join(managedRoot, entry.name);
      const lockPath = join(worktreePath, 'AGENT.lock');
      const payload = readJsonFile(lockPath);
      if (!payload) continue;
      sessions.push(...normalizeWorktreeLock(repoRoot, worktreePath, lockPath, payload, now));
    }
  }
  return sessions;
}

function normalizeWorktreeLock(
  repoRoot: string,
  worktreePath: string,
  filePath: string,
  payload: JsonRecord,
  now: number,
): HivemindSession[] {
  const telemetryUpdatedAt = normalizeIso(
    readString(payload.updatedAt) || readString(payload.updated_at),
  );
  const branch = readWorktreeBranch(worktreePath) || `agent/telemetry/${basename(worktreePath)}`;
  const entries = flattenLockSessions(payload);
  const lockSessions =
    entries.length > 0
      ? entries
      : [
          {
            taskPreview: readString(payload.taskPreview) || readString(payload.task_preview),
            taskUpdatedAt: telemetryUpdatedAt,
            projectName: '',
            projectPath: worktreePath,
            snapshotName: '',
            sessionKey: '',
          },
        ];

  return lockSessions
    .filter((entry) => entry.taskPreview || telemetryUpdatedAt)
    .map((entry) => {
      const updatedAt = entry.taskUpdatedAt || telemetryUpdatedAt;
      const startedAt = updatedAt || new Date(now).toISOString();
      const activity = classifyWorktreeLock(updatedAt, now);
      const taskName = entry.taskPreview || basename(worktreePath) || 'task';

      return {
        repo_root: resolve(repoRoot),
        source: 'worktree-lock' as const,
        branch,
        task: taskName,
        task_name: taskName,
        latest_task_preview: entry.taskPreview,
        agent: deriveAgentName(branch),
        cli: 'codex',
        state: '',
        activity,
        activity_summary: worktreeLockSummary(activity, updatedAt, now),
        worktree_path: resolve(entry.projectPath || worktreePath),
        pid: null,
        pid_alive: null,
        started_at: startedAt,
        last_heartbeat_at: '',
        updated_at: updatedAt,
        elapsed_seconds: elapsedSeconds(startedAt, now),
        task_mode: '',
        openspec_tier: '',
        routing_reason: '',
        snapshot_name: entry.snapshotName,
        project_name: entry.projectName,
        session_key: entry.sessionKey,
        locked_file_count: 0,
        locked_file_preview: [],
        file_path: filePath,
      };
    });
}

function mergeFileLockSessions(
  repoRoot: string,
  sessions: HivemindSession[],
  now: number,
): HivemindSession[] {
  const lockGroups = readFileLockGroups(repoRoot);
  if (lockGroups.length === 0) return sessions;

  const groupsByBranch = new Map(lockGroups.map((group) => [group.branch, group]));
  const coveredBranches = new Set<string>();
  const mergedSessions = sessions.map((session) => {
    coveredBranches.add(session.branch);
    const lockGroup = groupsByBranch.get(session.branch);
    return lockGroup ? annotateSessionWithFileLocks(session, lockGroup, now) : session;
  });

  for (const lockGroup of lockGroups) {
    if (!coveredBranches.has(lockGroup.branch)) {
      mergedSessions.push(buildFileLockSession(repoRoot, lockGroup, now));
    }
  }

  return mergedSessions;
}

function readFileLockGroups(repoRoot: string): FileLockGroup[] {
  const filePath = join(repoRoot, FILE_LOCKS_RELATIVE_PATH);
  const payload = readJsonFile(filePath);
  if (!payload || !isRecord(payload.locks)) return [];

  const claimsByBranch = new Map<string, FileLockClaim[]>();
  for (const [lockPath, value] of Object.entries(payload.locks)) {
    if (!isRecord(value)) continue;
    const branch = readString(value.branch);
    if (!branch) continue;
    const claim: FileLockClaim = {
      filePath: normalizeLockFilePath(lockPath),
      branch,
      claimedAt: normalizeIso(readString(value.claimed_at) || readString(value.claimedAt)),
    };
    const claims = claimsByBranch.get(branch) ?? [];
    claims.push(claim);
    claimsByBranch.set(branch, claims);
  }

  return [...claimsByBranch.entries()]
    .map(([branch, claims]) => buildFileLockGroup(repoRoot, filePath, branch, claims))
    .sort((left, right) => compareIsoDesc(left.latestClaimedAt, right.latestClaimedAt));
}

function buildFileLockGroup(
  repoRoot: string,
  filePath: string,
  branch: string,
  claims: FileLockClaim[],
): FileLockGroup {
  const sortedClaims = [...claims].sort((left, right) => {
    const timeDelta = compareIsoDesc(left.claimedAt, right.claimedAt);
    return timeDelta !== 0 ? timeDelta : left.filePath.localeCompare(right.filePath);
  });
  const validTimes = sortedClaims.map((claim) => claim.claimedAt).filter(Boolean);
  return {
    branch,
    claims: sortedClaims,
    latestClaimedAt: validTimes[0] ?? '',
    earliestClaimedAt: validTimes.at(-1) ?? '',
    preview: sortedClaims.slice(0, FILE_LOCK_PREVIEW_LIMIT).map((claim) => claim.filePath),
    worktreePath: resolveFileLockWorktreePath(repoRoot, branch, sortedClaims),
    filePath,
  };
}

function annotateSessionWithFileLocks(
  session: HivemindSession,
  group: FileLockGroup,
  now: number,
): HivemindSession {
  return {
    ...session,
    activity_summary: `${session.activity_summary} ${fileLockSummary(group, now)}`,
    updated_at: latestIso(session.updated_at, group.latestClaimedAt),
    locked_file_count: group.claims.length,
    locked_file_preview: group.preview,
  };
}

function buildFileLockSession(
  repoRoot: string,
  group: FileLockGroup,
  now: number,
): HivemindSession {
  const updatedAt = group.latestClaimedAt;
  const startedAt = group.earliestClaimedAt || updatedAt || new Date(now).toISOString();
  const taskPreview = group.preview.join(', ');
  const activity = classifyFileLockGroup(updatedAt, now);

  return {
    repo_root: resolve(repoRoot),
    source: 'file-lock',
    branch: group.branch,
    task: taskPreview ? `GX locks: ${taskPreview}` : `GX locks on ${group.branch}`,
    task_name: `GX file locks (${group.claims.length})`,
    latest_task_preview: taskPreview,
    agent: deriveAgentName(group.branch),
    cli: 'gx',
    state: '',
    activity,
    activity_summary: fileLockSummary(group, now),
    worktree_path: group.worktreePath,
    pid: null,
    pid_alive: null,
    started_at: startedAt,
    last_heartbeat_at: '',
    updated_at: updatedAt,
    elapsed_seconds: elapsedSeconds(startedAt, now),
    task_mode: '',
    openspec_tier: '',
    routing_reason: 'gx file locks',
    snapshot_name: '',
    project_name: '',
    session_key: '',
    locked_file_count: group.claims.length,
    locked_file_preview: group.preview,
    file_path: group.filePath,
  };
}

function resolveFileLockWorktreePath(
  repoRoot: string,
  branch: string,
  claims: FileLockClaim[],
): string {
  for (const claim of claims) {
    const inferred = inferManagedWorktreeFromLockedPath(repoRoot, claim.filePath);
    if (inferred) return inferred;
  }
  return findManagedWorktreeForBranch(repoRoot, branch) || resolve(repoRoot);
}

function inferManagedWorktreeFromLockedPath(repoRoot: string, filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length < 3) return '';
  if (parts[0] !== '.omx' && parts[0] !== '.omc') return '';
  if (parts[1] !== 'agent-worktrees' || !parts[2]) return '';

  const candidate = join(repoRoot, parts[0], parts[1], parts[2]);
  return existsSync(candidate) ? resolve(candidate) : '';
}

function findManagedWorktreeForBranch(repoRoot: string, branch: string): string {
  for (const relativeRoot of MANAGED_WORKTREE_ROOTS) {
    const managedRoot = join(repoRoot, relativeRoot);
    for (const entry of safeReadDir(managedRoot)) {
      if (!entry.isDirectory()) continue;
      const worktreePath = join(managedRoot, entry.name);
      if (readWorktreeBranch(worktreePath) === branch) {
        return resolve(worktreePath);
      }
    }
  }
  return '';
}

function normalizeLockFilePath(value: string): string {
  return value.trim().replace(/\\/g, '/');
}

function classifyFileLockGroup(updatedAt: string, now: number): HivemindActivity {
  const updatedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedAtMs)) return 'unknown';
  return now - updatedAtMs > FILE_LOCK_STALE_MS ? 'stalled' : 'working';
}

function fileLockSummary(group: FileLockGroup, now: number): string {
  const count = group.claims.length;
  if (!group.latestClaimedAt) {
    return `GX locks ${count} file(s); latest claim timestamp unavailable.`;
  }
  return `GX locks ${count} file(s); latest claim ${formatElapsed(group.latestClaimedAt, now)} ago.`;
}

function flattenLockSessions(payload: JsonRecord): Array<{
  taskPreview: string;
  taskUpdatedAt: string;
  projectName: string;
  projectPath: string;
  snapshotName: string;
  sessionKey: string;
}> {
  const snapshots = Array.isArray(payload.snapshots) ? payload.snapshots : [];
  const entries: Array<{
    taskPreview: string;
    taskUpdatedAt: string;
    projectName: string;
    projectPath: string;
    snapshotName: string;
    sessionKey: string;
  }> = [];

  for (const snapshot of snapshots) {
    if (!isRecord(snapshot)) continue;
    const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
    for (const session of sessions) {
      if (!isRecord(session)) continue;
      entries.push({
        taskPreview: readString(session.taskPreview) || readString(session.task_preview),
        taskUpdatedAt: normalizeIso(
          readString(session.taskUpdatedAt) || readString(session.task_updated_at),
        ),
        projectName: readString(session.projectName) || readString(session.project_name),
        projectPath: readString(session.projectPath) || readString(session.project_path),
        snapshotName: readString(snapshot.snapshotName) || readString(snapshot.snapshot_name),
        sessionKey: readString(session.sessionKey) || readString(session.session_key),
      });
    }
  }

  return entries;
}

function classifyActiveSession(input: {
  state: string;
  lastHeartbeatAt: string;
  pidAlive: boolean | null;
  now: number;
}): HivemindActivity {
  const heartbeatMs = Date.parse(input.lastHeartbeatAt);
  if (Number.isFinite(heartbeatMs) && input.now - heartbeatMs > HEARTBEAT_STALE_MS) {
    return 'dead';
  }
  if (input.pidAlive === false) {
    return 'dead';
  }
  if (input.state === 'working') return 'working';
  if (input.state === 'thinking') return 'thinking';
  if (input.state === 'idle') return 'idle';
  return 'unknown';
}

function classifyWorktreeLock(updatedAt: string, now: number): HivemindActivity {
  const updatedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedAtMs)) return 'unknown';
  return now - updatedAtMs > WORKTREE_LOCK_STALE_MS ? 'stalled' : 'working';
}

function activeActivitySummary(
  activity: HivemindActivity,
  state: string,
  lastHeartbeatAt: string,
  pidAlive: boolean | null,
  now: number,
): string {
  if (activity === 'dead' && pidAlive === false) return 'Recorded PID is not alive.';
  if (activity === 'dead') return `Heartbeat stale for ${formatElapsed(lastHeartbeatAt, now)}.`;
  if (state) return `Runtime state ${state}.`;
  return 'Runtime state unavailable.';
}

function worktreeLockSummary(activity: HivemindActivity, updatedAt: string, now: number): string {
  if (!updatedAt) return 'Telemetry task preview without timestamp.';
  const elapsed = formatElapsed(updatedAt, now);
  if (activity === 'stalled') return `Telemetry stale for ${elapsed}.`;
  return `Telemetry updated ${elapsed} ago.`;
}

function compareSessions(left: HivemindSession, right: HivemindSession): number {
  const updatedDelta = Date.parse(right.updated_at) - Date.parse(left.updated_at);
  if (Number.isFinite(updatedDelta) && updatedDelta !== 0) return updatedDelta;
  return `${left.repo_root}:${left.branch}:${left.task}`.localeCompare(
    `${right.repo_root}:${right.branch}:${right.task}`,
  );
}

function compareIsoDesc(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  const leftFinite = Number.isFinite(leftMs);
  const rightFinite = Number.isFinite(rightMs);
  if (leftFinite && rightFinite) return rightMs - leftMs;
  if (leftFinite) return -1;
  if (rightFinite) return 1;
  return 0;
}

function latestIso(left: string, right: string): string {
  return compareIsoDesc(left, right) <= 0 ? left : right;
}

function countActivities(sessions: HivemindSession[]): Record<HivemindActivity, number> {
  const counts: Record<HivemindActivity, number> = {
    working: 0,
    thinking: 0,
    idle: 0,
    stalled: 0,
    dead: 0,
    unknown: 0,
  };
  for (const session of sessions) {
    counts[session.activity] += 1;
  }
  return counts;
}

function listJsonFiles(dir: string): string[] {
  return safeReadDir(dir)
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(dir, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function safeReadDir(dir: string): Array<Dirent<string>> {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readJsonFile(filePath: string): JsonRecord | null {
  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) return null;
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readWorktreeBranch(worktreePath: string): string {
  const gitDir = resolveGitDir(worktreePath);
  if (!gitDir) return '';
  const headPath = join(gitDir, 'HEAD');
  try {
    const head = readFileSync(headPath, 'utf8').trim();
    const refPrefix = 'ref: refs/heads/';
    if (head.startsWith(refPrefix)) return head.slice(refPrefix.length);
    return '';
  } catch {
    return '';
  }
}

function resolveGitDir(worktreePath: string): string {
  const dotGitPath = join(worktreePath, '.git');
  try {
    const stats = statSync(dotGitPath);
    if (stats.isDirectory()) return dotGitPath;
    if (!stats.isFile()) return '';
    const pointer = readFileSync(dotGitPath, 'utf8');
    const match = pointer.match(/^gitdir:\s*(.+)$/m);
    return match?.[1] ? resolve(worktreePath, match[1].trim()) : '';
  } catch {
    return '';
  }
}

function readPositiveInteger(value: unknown): number | null {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeState(value: string): string {
  const normalized = value.toLowerCase();
  return ['working', 'thinking', 'idle'].includes(normalized) ? normalized : '';
}

function normalizeIso(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function elapsedSeconds(startedAt: string, now: number): number {
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) return 0;
  return Math.max(0, Math.floor((now - startedAtMs) / 1000));
}

function formatElapsed(startedAt: string, now: number): string {
  const totalSeconds = elapsedSeconds(startedAt, now);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === 'EPERM';
  }
}

function deriveAgentName(branch: string): string {
  const parts = branch.split('/').filter(Boolean);
  return parts[0] === 'agent' && parts[1] ? parts[1] : 'agent';
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
