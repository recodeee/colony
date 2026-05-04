import { execFileSync as nodeExecFileSync, spawnSync as nodeSpawnSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import {
  type MemoryStore,
  type PlanInfo,
  type SubtaskInfo,
  TaskThread,
  areDepsMet,
  listPlans,
} from '@colony/core';
import kleur from 'kleur';

export type GitGuardexExecFileSync = (
  file: string,
  args: string[],
  options: {
    cwd?: string;
    encoding: 'utf8';
    stdio: ['ignore', 'pipe', 'pipe'];
  },
) => string | Buffer;

export type GitGuardexAgent = 'codex' | 'claude';

export interface GitGuardexAvailability {
  available: boolean;
  version: string | null;
  status_json_available: boolean;
  status_json: unknown | null;
  reason: string | null;
}

export interface GitGuardexLane {
  session_id: string | null;
  branch: string | null;
  worktree: string | null;
  agent: string | null;
  task: string | null;
  claimed_files: string[];
  dirty_files: string[];
  pr_url: string | null;
  pr_state: string | null;
}

export interface GitGuardexColonyClaim {
  task_id: number;
  task_title: string;
  branch: string;
  file_path: string;
  session_id: string;
}

export interface GitGuardexLanesPayload {
  status: 'available' | 'unavailable';
  command: 'gx agents status --json';
  repo_root: string | null;
  schema_version: string | number | null;
  active_lanes: number;
  lanes: GitGuardexLane[];
  claimed_files: string[];
  orphan_gx_lanes: GitGuardexLane[];
  colony_claims_without_gx_lane: GitGuardexColonyClaim[];
  error: string | null;
}

export interface GitGuardexSpawnOptions {
  store: MemoryStore;
  repoRoot: string;
  agent: GitGuardexAgent;
  base: string;
  dryRun: boolean;
  planSlug?: string;
  subtaskIndex?: number;
  execFileSync?: GitGuardexExecFileSync;
}

export interface GitGuardexSpawnResult {
  dry_run: boolean;
  command: string;
  argv: string[];
  repo_root: string;
  agent: GitGuardexAgent;
  base: string;
  plan_slug: string;
  subtask_index: number;
  task_id: number;
  title: string;
  files: string[];
  colony_session_id: string | null;
  gx_stdout: string | null;
  colony_claimed: boolean;
}

export interface GitGuardexCockpitResult {
  dry_run: boolean;
  command: string;
  argv: string[];
  repo_root: string;
  session_name: string;
  stdout: string | null;
}

export class GitGuardexExecutorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'GitGuardexExecutorError';
    this.code = code;
  }
}

interface ReadGitGuardexLanesOptions {
  cwd?: string;
  colony_claims?: GitGuardexColonyClaim[];
  execFileSync?: GitGuardexExecFileSync;
}

type JsonObject = Record<string, unknown>;

const GX_STATUS_COMMAND = 'gx agents status --json' as const;

export function detectGitGuardexAvailability(
  repoRoot: string,
  execFileSync: GitGuardexExecFileSync = nodeExecFileSync,
): GitGuardexAvailability {
  const cwd = resolve(repoRoot);
  let version: string;
  try {
    version = execGx(execFileSync, ['--version'], cwd).trim();
  } catch (err) {
    return {
      available: false,
      version: null,
      status_json_available: false,
      status_json: null,
      reason: errorMessage(err),
    };
  }

  try {
    return {
      available: true,
      version,
      status_json_available: true,
      status_json: JSON.parse(execGx(execFileSync, ['status', '--json'], cwd)) as unknown,
      reason: null,
    };
  } catch {
    return {
      available: true,
      version,
      status_json_available: false,
      status_json: null,
      reason: null,
    };
  }
}

export function readGitGuardexLanes(
  options: ReadGitGuardexLanesOptions = {},
): GitGuardexLanesPayload {
  try {
    const output =
      options.execFileSync === undefined
        ? readGitGuardexStatus(options.cwd)
        : String(
            options.execFileSync('gx', ['agents', 'status', '--json'], {
              ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
            }),
          );
    return buildGitGuardexLanesPayload(JSON.parse(output) as unknown, options.colony_claims ?? []);
  } catch (err) {
    return unavailableGitGuardexLanes(errorMessage(err));
  }
}

export function spawnGitGuardexAgent(options: GitGuardexSpawnOptions): GitGuardexSpawnResult {
  const execFileSync = options.execFileSync ?? nodeExecFileSync;
  const repoRoot = resolve(options.repoRoot);
  const availability = detectGitGuardexAvailability(repoRoot, execFileSync);
  if (!availability.available) {
    throw new GitGuardexExecutorError(
      'GX_UNAVAILABLE',
      `GitGuardex unavailable: ${availability.reason ?? 'gx not found'}`,
    );
  }

  const { plan, subtask } = resolveReadySubtask(options.store, {
    repoRoot,
    ...(options.planSlug !== undefined ? { planSlug: options.planSlug } : {}),
    ...(options.subtaskIndex !== undefined ? { subtaskIndex: options.subtaskIndex } : {}),
  });
  const lanes = readGitGuardexLanes({ cwd: repoRoot, execFileSync });
  assertNoDuplicateGxLane(lanes, plan.plan_slug, subtask.subtask_index);
  assertNoOverlappingGxClaims(lanes, subtask.file_scope);

  const argv = buildGitGuardexStartArgs({
    repoRoot,
    agent: options.agent,
    base: options.base,
    dryRun: options.dryRun,
    plan,
    subtask,
  });
  const command = formatCommand('gx', argv);

  if (options.dryRun) {
    return spawnResult({
      dryRun: true,
      command,
      argv,
      repoRoot,
      options,
      plan,
      subtask,
      colonySessionId: null,
      gxStdout: null,
      colonyClaimed: false,
    });
  }

  const stdout = execGx(execFileSync, argv, repoRoot);
  const gxSession = parseGxStartSession(stdout);
  const colonySessionId = gxSession.id
    ? `gx:${gxSession.id}`
    : `gx:${plan.plan_slug}:sub-${subtask.subtask_index}:${options.agent}`;
  syncColonyClaims(options.store, {
    sessionId: colonySessionId,
    agent: options.agent,
    repoRoot,
    plan,
    subtask,
    gxSession,
  });

  return spawnResult({
    dryRun: false,
    command,
    argv,
    repoRoot,
    options,
    plan,
    subtask,
    colonySessionId,
    gxStdout: stdout,
    colonyClaimed: true,
  });
}

export function buildGitGuardexCockpitCommand(
  repoRoot: string,
  sessionName = defaultCockpitSessionName(repoRoot),
): string[] {
  return ['cockpit', '--target', resolve(repoRoot), '--session', sessionName];
}

export function runGitGuardexCockpit(options: {
  repoRoot: string;
  dryRun: boolean;
  sessionName?: string;
  execFileSync?: GitGuardexExecFileSync;
}): GitGuardexCockpitResult {
  const execFileSync = options.execFileSync ?? nodeExecFileSync;
  const repoRoot = resolve(options.repoRoot);
  const sessionName = options.sessionName ?? defaultCockpitSessionName(repoRoot);
  const argv = buildGitGuardexCockpitCommand(repoRoot, sessionName);
  const command = formatCommand('gx', argv);
  if (options.dryRun) {
    return {
      dry_run: true,
      command,
      argv,
      repo_root: repoRoot,
      session_name: sessionName,
      stdout: null,
    };
  }
  const availability = detectGitGuardexAvailability(repoRoot, execFileSync);
  if (!availability.available) {
    throw new GitGuardexExecutorError(
      'GX_UNAVAILABLE',
      `GitGuardex unavailable: ${availability.reason ?? 'gx not found'}`,
    );
  }
  return {
    dry_run: false,
    command,
    argv,
    repo_root: repoRoot,
    session_name: sessionName,
    stdout: execGx(execFileSync, argv, repoRoot),
  };
}

export function nextReadySpawnCommands(
  store: MemoryStore,
  repoRoot: string,
  agent: GitGuardexAgent = 'codex',
  base = 'main',
): string[] {
  const resolvedRoot = resolve(repoRoot);
  return listPlans(store, { repo_root: resolvedRoot, limit: 2000 })
    .flatMap((plan) =>
      plan.next_available.map((subtask) =>
        formatCommand('colony', [
          'agents',
          'spawn',
          '--executor',
          'gx',
          '--plan',
          plan.plan_slug,
          '--subtask',
          String(subtask.subtask_index),
          '--agent',
          agent,
          '--base',
          base,
          '--repo-root',
          resolvedRoot,
        ]),
      ),
    )
    .slice(0, 10);
}

export function defaultCockpitSessionName(repoRoot: string): string {
  const slug = basename(resolve(repoRoot))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `colony-${slug || 'repo'}`;
}

export function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(' ');
}

export function unavailableGitGuardexLanes(error: string | null): GitGuardexLanesPayload {
  return {
    status: 'unavailable',
    command: GX_STATUS_COMMAND,
    repo_root: null,
    schema_version: null,
    active_lanes: 0,
    lanes: [],
    claimed_files: [],
    orphan_gx_lanes: [],
    colony_claims_without_gx_lane: [],
    error,
  };
}

export function buildGitGuardexLanesPayload(
  raw: unknown,
  colonyClaims: GitGuardexColonyClaim[] = [],
): GitGuardexLanesPayload {
  const root = isRecord(raw) ? raw : {};
  const lanes = readLaneArray(root).map(normalizeLane).sort(compareLanes);
  const claimedFiles = uniqueSorted(lanes.flatMap((lane) => lane.claimed_files));
  return {
    status: 'available',
    command: GX_STATUS_COMMAND,
    repo_root: readString(root, ['repoRoot', 'repo_root', 'repositoryRoot']),
    schema_version: readStringOrNumber(root, ['schemaVersion', 'schema_version']),
    active_lanes: lanes.length,
    lanes,
    claimed_files: claimedFiles,
    orphan_gx_lanes: lanes.filter(
      (lane) => !colonyClaims.some((claim) => laneMatchesClaim(lane, claim)),
    ),
    colony_claims_without_gx_lane: colonyClaims.filter(
      (claim) => !lanes.some((lane) => laneMatchesClaim(lane, claim)),
    ),
    error: null,
  };
}

export function collectGitGuardexColonyClaims(
  tasks: Array<{ id: number; title: string; branch: string }>,
  listClaims: (taskId: number) => Array<{
    task_id: number;
    file_path: string;
    session_id: string;
    state?: string;
  }>,
): GitGuardexColonyClaim[] {
  return tasks.flatMap((task) =>
    listClaims(task.id)
      .filter((claim) => claim.state === undefined || claim.state === 'active')
      .map((claim) => ({
        task_id: claim.task_id,
        task_title: task.title,
        branch: task.branch,
        file_path: normalizeFilePath(claim.file_path),
        session_id: claim.session_id,
      })),
  );
}

export function formatGitGuardexLanesOutput(
  payload: GitGuardexLanesPayload,
  options: { limit?: number } = {},
): string[] {
  const limit = options.limit ?? 5;
  const lines = [
    `  status: ${payload.status}`,
    `  active lanes: ${payload.active_lanes}`,
    `  claimed files: ${payload.claimed_files.length}`,
    `  orphan gx lanes: ${payload.orphan_gx_lanes.length}`,
    `  colony claims without gx lane: ${payload.colony_claims_without_gx_lane.length}`,
  ];
  if (payload.status === 'unavailable') {
    lines.push(kleur.dim(`  command: ${payload.command}`));
    if (payload.error) lines.push(kleur.dim(`  reason: ${payload.error}`));
    return lines;
  }
  if (payload.lanes.length === 0) {
    lines.push(kleur.dim('  lanes: none active'));
    return lines;
  }
  lines.push('  lanes:');
  for (const lane of payload.lanes.slice(0, limit)) {
    lines.push(`    - ${lane.branch ?? 'unknown-branch'} (${lane.session_id ?? 'no-session'})`);
    if (lane.agent || lane.task)
      lines.push(`      ${compactParts([lane.agent, lane.task]).join(' | ')}`);
    if (lane.worktree) lines.push(`      worktree: ${lane.worktree}`);
    if (lane.claimed_files.length > 0) {
      lines.push(`      claimed: ${lane.claimed_files.slice(0, limit).join(', ')}`);
    }
    if (lane.dirty_files.length > 0) {
      lines.push(`      dirty: ${lane.dirty_files.slice(0, limit).join(', ')}`);
    }
    if (lane.pr_url || lane.pr_state) {
      lines.push(`      PR: ${compactParts([lane.pr_state, lane.pr_url]).join(' ')}`);
    }
  }
  return lines;
}

function readGitGuardexStatus(cwd: string | undefined): string {
  const direct = runGitGuardexStatusCommand(cwd);
  if (direct.length > 0) return direct;

  const tty = nodeSpawnSync('script', ['-q', '/dev/null', '-c', GX_STATUS_COMMAND], {
    ...(cwd !== undefined ? { cwd } : {}),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (tty.error) return direct;
  if (tty.status !== 0) return direct;
  return `${tty.stdout}${tty.stderr}`.trim();
}

function runGitGuardexStatusCommand(cwd: string | undefined): string {
  const result = nodeSpawnSync('gx', ['agents', 'status', '--json'], {
    ...(cwd !== undefined ? { cwd } : {}),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (result.status !== 0) {
    throw new Error(stderr || stdout || `gx agents status --json exited ${result.status}`);
  }
  return stdout || stderr;
}

function resolveReadySubtask(
  store: MemoryStore,
  args: {
    repoRoot: string;
    planSlug?: string;
    subtaskIndex?: number;
  },
): { plan: PlanInfo; subtask: SubtaskInfo } {
  const plans = listPlans(store, { repo_root: args.repoRoot, limit: 2000 });
  if (args.planSlug === undefined && args.subtaskIndex === undefined) {
    for (const plan of plans) {
      const subtask = plan.next_available[0];
      if (subtask) return { plan, subtask };
    }
    throw new GitGuardexExecutorError(
      'NO_READY_SUBTASK',
      'No ready Colony plan subtasks. Publish a Queen/task plan or pass --plan and --subtask for an available ready subtask.',
    );
  }
  if (args.planSlug === undefined || args.subtaskIndex === undefined) {
    throw new GitGuardexExecutorError(
      'SUBTASK_SELECTION_INCOMPLETE',
      '--plan and --subtask must be provided together',
    );
  }
  const plan = plans.find((candidate) => candidate.plan_slug === args.planSlug);
  if (!plan)
    throw new GitGuardexExecutorError('PLAN_NOT_FOUND', `plan not found: ${args.planSlug}`);
  const subtask = plan.subtasks.find((candidate) => candidate.subtask_index === args.subtaskIndex);
  if (!subtask) {
    throw new GitGuardexExecutorError(
      'SUBTASK_NOT_FOUND',
      `sub-task not found: ${args.planSlug}/sub-${args.subtaskIndex}`,
    );
  }
  if (subtask.status !== 'available') {
    const owner = subtask.claimed_by_session_id ? ` by ${subtask.claimed_by_session_id}` : '';
    throw new GitGuardexExecutorError(
      'SUBTASK_NOT_AVAILABLE',
      `sub-task ${args.planSlug}/sub-${args.subtaskIndex} is ${subtask.status}${owner}`,
    );
  }
  if (!areDepsMet(subtask, plan.subtasks)) {
    throw new GitGuardexExecutorError(
      'SUBTASK_NOT_READY',
      `sub-task ${args.planSlug}/sub-${args.subtaskIndex} dependencies are not complete`,
    );
  }
  return { plan, subtask };
}

function buildGitGuardexStartArgs(args: {
  repoRoot: string;
  agent: GitGuardexAgent;
  base: string;
  dryRun: boolean;
  plan: PlanInfo;
  subtask: SubtaskInfo;
}): string[] {
  const argv = [
    'agents',
    'start',
    buildAgentPrompt(args.plan, args.subtask, args.repoRoot),
    '--agent',
    args.agent,
    '--base',
    args.base,
  ];
  for (const file of args.subtask.file_scope) argv.push('--claim', file);
  argv.push('--target', args.repoRoot);
  if (args.dryRun) argv.push('--dry-run');
  return argv;
}

function buildAgentPrompt(plan: PlanInfo, subtask: SubtaskInfo, repoRoot: string): string {
  const description = subtask.description.replace(/\s+/g, ' ').trim();
  const parts = [
    `Colony plan ${plan.plan_slug}/sub-${subtask.subtask_index}: ${subtask.title}`,
    `repo_root=${repoRoot}`,
    `task_id=${subtask.task_id}`,
    `files=${subtask.file_scope.length > 0 ? subtask.file_scope.join(',') : '-'}`,
  ];
  if (description) parts.push(`description=${description}`);
  parts.push(
    'Colony source of truth: claim with task_plan_claim_subtask, keep task_note_working updated, complete with task_plan_complete_subtask.',
  );
  return parts.join(' | ');
}

function assertNoDuplicateGxLane(
  lanes: GitGuardexLanesPayload,
  planSlug: string,
  subtaskIndex: number,
): void {
  const needle = `Colony plan ${planSlug}/sub-${subtaskIndex}:`;
  const duplicate = lanes.lanes.find((lane) => lane.task?.includes(needle));
  if (!duplicate) return;
  throw new GitGuardexExecutorError(
    'GX_DUPLICATE_LANE',
    `sub-task ${planSlug}/sub-${subtaskIndex} already has gx session ${
      duplicate.session_id ?? '(unknown)'
    } on ${duplicate.branch ?? '(unknown branch)'}`,
  );
}

function assertNoOverlappingGxClaims(lanes: GitGuardexLanesPayload, files: string[]): void {
  const wanted = new Set(files.map(normalizeFilePath));
  for (const lane of lanes.lanes) {
    const overlap = lane.claimed_files.filter((file) => wanted.has(normalizeFilePath(file)));
    if (overlap.length === 0) continue;
    throw new GitGuardexExecutorError(
      'GX_CLAIM_OVERLAP',
      `gx lane ${lane.branch ?? lane.session_id ?? '(unknown)'} already owns ${overlap.join(', ')}`,
    );
  }
}

interface ParsedGxStartSession {
  id: string | null;
  branch: string | null;
  worktreePath: string | null;
}

function parseGxStartSession(stdout: string): ParsedGxStartSession {
  return {
    id: matchLine(stdout, /Agent session id:\s*(.+)$/m),
    branch: matchLine(stdout, /(?:Created branch|Reusing existing branch):\s*(.+)$/m),
    worktreePath: matchLine(stdout, /Worktree:\s*(.+)$/m),
  };
}

function syncColonyClaims(
  store: MemoryStore,
  args: {
    sessionId: string;
    agent: GitGuardexAgent;
    repoRoot: string;
    plan: PlanInfo;
    subtask: SubtaskInfo;
    gxSession: ParsedGxStartSession;
  },
): void {
  store.storage.transaction(() => {
    store.startSession({ id: args.sessionId, ide: `gx:${args.agent}`, cwd: args.repoRoot });
    const thread = new TaskThread(store, args.subtask.task_id);
    thread.join(args.sessionId, args.agent);
    store.addObservation({
      session_id: args.sessionId,
      task_id: args.subtask.task_id,
      kind: 'plan-subtask-claim',
      content: `gx agents start claimed sub-task ${args.subtask.subtask_index} of plan ${args.plan.plan_slug}`,
      metadata: {
        status: 'claimed',
        session_id: args.sessionId,
        agent: args.agent,
        plan_slug: args.plan.plan_slug,
        subtask_index: args.subtask.subtask_index,
        executor: 'gx',
        gx_session_id: args.gxSession.id,
        gx_branch: args.gxSession.branch,
        gx_worktree: args.gxSession.worktreePath,
      },
    });
    for (const file of args.subtask.file_scope) {
      thread.claimFile({
        session_id: args.sessionId,
        file_path: file,
        note: 'synced from gx agents start --claim',
        metadata: {
          executor: 'gx',
          gx_session_id: args.gxSession.id,
          gx_branch: args.gxSession.branch,
        },
      });
    }
  });
}

function spawnResult(args: {
  dryRun: boolean;
  command: string;
  argv: string[];
  repoRoot: string;
  options: GitGuardexSpawnOptions;
  plan: PlanInfo;
  subtask: SubtaskInfo;
  colonySessionId: string | null;
  gxStdout: string | null;
  colonyClaimed: boolean;
}): GitGuardexSpawnResult {
  return {
    dry_run: args.dryRun,
    command: args.command,
    argv: args.argv,
    repo_root: args.repoRoot,
    agent: args.options.agent,
    base: args.options.base,
    plan_slug: args.plan.plan_slug,
    subtask_index: args.subtask.subtask_index,
    task_id: args.subtask.task_id,
    title: args.subtask.title,
    files: args.subtask.file_scope,
    colony_session_id: args.colonySessionId,
    gx_stdout: args.gxStdout,
    colony_claimed: args.colonyClaimed,
  };
}

function readLaneArray(root: JsonObject): unknown[] {
  for (const candidate of [
    root.sessions,
    root.lanes,
    root.active_lanes,
    root.activeLanes,
    root.agents,
  ]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function normalizeLane(raw: unknown): GitGuardexLane {
  const item = isRecord(raw) ? raw : {};
  return {
    session_id: readString(item, ['session_id', 'sessionId', 'session', 'id', ['session', 'id']]),
    branch: readString(item, ['branch', 'branchName', ['git', 'branch'], ['lane', 'branch']]),
    worktree: readString(item, ['worktree', 'worktree_path', 'worktreePath', 'path', 'cwd']),
    agent: readString(item, ['agent', 'agent_name', 'agentName', 'owner', 'ide']),
    task: readString(item, ['task', 'title', 'task_title', 'taskTitle', 'summary', 'prompt']),
    claimed_files: readFileArray(item, [
      'claimed_files',
      'claimedFiles',
      'locked_files',
      'lockedFiles',
      'locks',
      'claims',
      'files',
    ]),
    dirty_files: readFileArray(item, ['dirty_files', 'dirtyFiles', ['dirty', 'files']]),
    pr_url: readString(item, [
      'pr_url',
      'prUrl',
      'pull_request_url',
      'pullRequestUrl',
      ['pr', 'url'],
    ]),
    pr_state: readString(item, [
      'pr_state',
      'prState',
      'pull_request_state',
      'pullRequestState',
      ['pr', 'state'],
    ]),
  };
}

function readFileArray(item: JsonObject, paths: Array<string | string[]>): string[] {
  for (const path of paths) {
    const value = readPath(item, path);
    const files = normalizeFileArray(value);
    if (files.length > 0) return files;
  }
  return [];
}

function normalizeFileArray(value: unknown): string[] {
  if (typeof value === 'string') return [normalizeFilePath(value)].filter(Boolean);
  if (Array.isArray(value)) {
    return uniqueSorted(
      value
        .flatMap((entry) => {
          if (typeof entry === 'string') return [entry];
          if (!isRecord(entry)) return [];
          return [
            readString(entry, ['file_path', 'filePath', 'path', 'file']),
            readString(entry, ['name']),
          ];
        })
        .filter((entry): entry is string => typeof entry === 'string')
        .map(normalizeFilePath)
        .filter(Boolean),
    );
  }
  if (isRecord(value))
    return readFileArray(value, ['files', 'paths', 'claimed_files', 'dirty_files']);
  return [];
}

function laneMatchesClaim(lane: GitGuardexLane, claim: GitGuardexColonyClaim): boolean {
  if (lane.session_id && lane.session_id === claim.session_id) return true;
  if (lane.branch && lane.branch === claim.branch) return true;
  return new Set(lane.claimed_files.map(normalizeFilePath)).has(normalizeFilePath(claim.file_path));
}

function readString(root: JsonObject, paths: Array<string | string[]>): string | null {
  for (const path of paths) {
    const value = readPath(root, path);
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function readStringOrNumber(
  root: JsonObject,
  paths: Array<string | string[]>,
): string | number | null {
  for (const path of paths) {
    const value = readPath(root, path);
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function readPath(root: JsonObject, path: string | string[]): unknown {
  const segments = Array.isArray(path) ? path : [path];
  let value: unknown = root;
  for (const segment of segments) {
    if (!isRecord(value)) return undefined;
    value = value[segment];
  }
  return value;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeFilePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function compactParts(values: Array<string | null>): string[] {
  return values.filter((value): value is string => value !== null && value.length > 0);
}

function compareLanes(left: GitGuardexLane, right: GitGuardexLane): number {
  return (
    (left.branch ?? '').localeCompare(right.branch ?? '') ||
    (left.session_id ?? '').localeCompare(right.session_id ?? '') ||
    (left.worktree ?? '').localeCompare(right.worktree ?? '')
  );
}

function matchLine(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function execGx(execFileSync: GitGuardexExecFileSync, args: string[], cwd: string): string {
  return String(
    execFileSync('gx', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}
