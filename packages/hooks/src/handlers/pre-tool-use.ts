import { resolve } from 'node:path';
import type { BridgePolicyMode } from '@colony/config';
import {
  type ClaimAgeClass,
  type ClaimOwnershipStrength,
  type MemoryStore,
  TaskThread,
  classifyClaimAge,
  detectRepoBranch,
  isStrongClaimAge,
  normalizeClaimFilePath,
} from '@colony/core';
import {
  type ActiveTaskCandidate,
  type AutoClaimFailureCode,
  type AutoClaimFileForSessionResult,
  activeTaskCandidatesForSession,
  autoClaimFileBeforeEdit,
} from '../auto-claim.js';
import type { HookInput } from '../types.js';
import { extractTouchedFiles, pathExtractionWarningsForToolUse } from './post-tool-use.js';

const CLAIM_WARNING_DEBOUNCE_MS = 60_000;
const CLAIM_BEFORE_EDIT_FALLBACK_SESSION_ID = 'colony-pre-tool-use-diagnostics';
const ALL_TASKS_LIMIT = 1_000_000;
const PROTECTED_BRANCHES = new Set(['main', 'dev', 'master', 'trunk']);
const claimWarningDebounceByStore = new WeakMap<MemoryStore, Map<string, number>>();

export interface ClaimBeforeEditFallbackWarning {
  code: ClaimBeforeEditWarningCode;
  message: string;
  warning?: string;
  policy_mode?: BridgePolicyMode;
  conflict?: boolean;
  conflict_strength?: ConflictStrength;
  protected?: boolean;
  owner?: string | null;
  owner_branch?: string | null;
  next_tool: 'task_claim_file';
  /** Concrete invocation string the agent can copy verbatim. */
  next_call: string;
  suggested_args: {
    task_id: number | '<task_id>' | '<candidate.task_id>';
    session_id: string;
    file_path: string;
    note: string;
  };
  candidates?: CompactCandidate[];
  creation_guidance?: string;
}

export interface ClaimBeforeEditHookResult {
  context: string;
  permissionDecision: 'allow' | 'deny';
  permissionDecisionReason?: string;
  extracted_paths: string[];
  warnings?: string[];
}

export interface ClaimBeforeEditResult {
  policy_mode: BridgePolicyMode;
  files: string[];
  extracted_paths: string[];
  path_extraction_warnings: string[];
  edits_with_claim: string[];
  edits_missing_claim: string[];
  auto_claimed_before_edit: string[];
  conflicts: ClaimConflictInfo[];
  blocked_conflicts: ClaimConflictInfo[];
  warnings: ClaimBeforeEditFallbackWarning[];
}

type PreToolUseInput = Pick<
  HookInput,
  'session_id' | 'tool_name' | 'tool' | 'tool_input' | 'cwd' | 'ide' | 'metadata'
>;
type AutoClaimFailure = Extract<AutoClaimFileForSessionResult, { ok: false }>;
type ClaimBeforeEditWarningCode = AutoClaimFailureCode | 'LIVE_FILE_CONTENTION';
type ConflictStrength = ClaimOwnershipStrength | 'none';
type CompactCandidate = Pick<
  ActiveTaskCandidate,
  'task_id' | 'title' | 'repo_root' | 'branch' | 'status' | 'updated_at' | 'active_files'
>;

interface ClaimConflictInfo {
  file_path: string;
  task_id: number;
  owner: string;
  owner_branch?: string;
  protected?: boolean;
  conflict_strength: ClaimOwnershipStrength;
  claimed_at: number;
  age_minutes: number;
  age_class: ClaimAgeClass;
  warning: string;
}

export function preToolUse(store: MemoryStore, input: HookInput): string {
  return preToolUseResult(store, input).context;
}

export function preToolUseResult(store: MemoryStore, input: HookInput): ClaimBeforeEditHookResult {
  const toolName = input.tool_name ?? input.tool ?? '';
  try {
    return bridgePolicyResult(claimBeforeEditFromToolUse(store, input));
  } catch {
    const scope = taskScopeForToolUse(store, input);
    const files = extractTouchedFiles(toolName, input.tool_input, {
      cwd: scope.cwd ?? input.cwd,
      repoRoot: scope.repo_root,
    });
    const policyMode = bridgePolicyMode(store);
    const pathExtractionWarnings = pathExtractionWarningsForToolUse(
      toolName,
      input.tool_input,
      files,
    );
    if (pathExtractionWarnings.length > 0) {
      recordPathExtractionFailure(store, input.session_id, {
        tool: toolName,
        policy_mode: policyMode,
        warnings: pathExtractionWarnings,
        scope,
      });
    }
    return bridgePolicyResult({
      policy_mode: policyMode,
      files,
      extracted_paths: files,
      path_extraction_warnings: pathExtractionWarnings,
      edits_with_claim: [],
      edits_missing_claim: files,
      auto_claimed_before_edit: [],
      conflicts: [],
      blocked_conflicts: [],
      warnings: files.map((file_path) =>
        claimWarning(input.session_id, file_path, toolName, policyMode, {
          ok: false,
          code: 'COLONY_UNAVAILABLE',
          error: 'Colony unavailable for auto-claim',
          candidates: [],
        }),
      ),
    });
  }
}

export function claimBeforeEditFromToolUse(
  store: MemoryStore,
  input: PreToolUseInput,
): ClaimBeforeEditResult {
  const toolName = input.tool_name ?? input.tool ?? '';
  const policyMode = bridgePolicyMode(store);
  const scope = taskScopeForToolUse(store, input);
  const files = extractTouchedFiles(toolName, input.tool_input, {
    repoRoot: scope.repo_root,
    cwd: scope.cwd ?? scope.worktree_path,
  });
  const pathExtractionWarnings = pathExtractionWarningsForToolUse(
    toolName,
    input.tool_input,
    files,
  );
  const result: ClaimBeforeEditResult = {
    policy_mode: policyMode,
    files,
    extracted_paths: files,
    path_extraction_warnings: pathExtractionWarnings,
    edits_with_claim: [],
    edits_missing_claim: [],
    auto_claimed_before_edit: [],
    conflicts: [],
    blocked_conflicts: [],
    warnings: [],
  };
  if (files.length === 0) {
    if (pathExtractionWarnings.length > 0) {
      recordPathExtractionFailure(store, input.session_id, {
        tool: toolName,
        policy_mode: policyMode,
        warnings: pathExtractionWarnings,
        scope,
      });
    }
    return result;
  }

  ensurePreToolUseTask(store, input, scope);

  for (const file_path of files) {
    const protectedConflict = protectedLiveClaimConflict(store, input.session_id, scope, file_path);
    if (protectedConflict) {
      result.conflicts.push(protectedConflict);
      result.edits_missing_claim.push(file_path);
      result.blocked_conflicts.push(protectedConflict);
      recordClaimBeforeEditFailure(store, input.session_id, {
        task_id: protectedConflict.task_id,
        file_path,
        tool: toolName,
        code: 'LIVE_FILE_CONTENTION',
        error: protectedConflict.warning,
        candidates: [],
        policy_mode: policyMode,
        conflict: protectedConflict,
        extracted_paths: files,
      });
      result.warnings.push(
        claimWarning(input.session_id, file_path, toolName, policyMode, {
          ok: false,
          code: 'LIVE_FILE_CONTENTION',
          error: protectedConflict.warning,
          candidates: [],
          conflict: protectedConflict,
        }),
      );
      continue;
    }

    const conflict = currentClaimConflict(store, input.session_id, scope, file_path);
    if (conflict) result.conflicts.push(conflict);

    if (policyMode === 'block-on-conflict' && conflict?.conflict_strength === 'strong') {
      result.edits_missing_claim.push(file_path);
      result.blocked_conflicts.push(conflict);
      recordClaimBeforeEditFailure(store, input.session_id, {
        task_id: conflict.task_id,
        file_path,
        tool: toolName,
        code: 'LIVE_FILE_CONTENTION',
        error: conflict.warning,
        candidates: [],
        policy_mode: policyMode,
        conflict,
        extracted_paths: files,
      });
      result.warnings.push(
        claimWarning(input.session_id, file_path, toolName, policyMode, {
          ok: false,
          code: 'LIVE_FILE_CONTENTION',
          error: conflict.warning,
          candidates: [],
          conflict,
        }),
      );
      continue;
    }

    const claim = autoClaimFileBeforeEdit({
      store,
      session_id: input.session_id,
      ...scope,
      file_path,
      note: `auto before ${toolName}`,
      source: 'pre-tool-use',
      tool: toolName,
      record_conflict: true,
    });

    if (claim.ok && claim.status === 'already_claimed') {
      result.edits_with_claim.push(file_path);
      recordClaimBeforeEdit(store, input.session_id, claim.task_id, {
        outcome: 'edits_with_claim',
        file_path,
        tool: toolName,
        policy_mode: policyMode,
        extracted_paths: files,
      });
      continue;
    }

    if (claim.ok) {
      result.auto_claimed_before_edit.push(file_path);
      recordClaimBeforeEdit(store, input.session_id, claim.task_id, {
        outcome: 'auto_claimed_before_edit',
        file_path,
        tool: toolName,
        policy_mode: policyMode,
        ...(conflict ? { conflict } : {}),
        ...(claim.observation_id !== null ? { claim_observation_id: claim.observation_id } : {}),
        extracted_paths: files,
      });
      if (conflict) {
        result.warnings.push(
          claimWarning(input.session_id, file_path, toolName, policyMode, {
            ok: false,
            code: 'LIVE_FILE_CONTENTION',
            error: conflict.warning,
            candidates: [],
            conflict,
          }),
        );
      }
      continue;
    }

    if (
      conflict &&
      (claim.code === 'CLAIM_HELD_BY_ACTIVE_OWNER' || claim.code === 'CLAIM_TAKEOVER_RECOMMENDED')
    ) {
      result.edits_missing_claim.push(file_path);
      recordClaimBeforeEditFailure(store, input.session_id, {
        task_id: conflict.task_id,
        file_path,
        tool: toolName,
        code: 'LIVE_FILE_CONTENTION',
        error: conflict.warning,
        candidates: [],
        policy_mode: policyMode,
        conflict,
        extracted_paths: files,
      });
      result.warnings.push(
        claimWarning(input.session_id, file_path, toolName, policyMode, {
          ok: false,
          code: 'LIVE_FILE_CONTENTION',
          error: conflict.warning,
          candidates: [],
          conflict,
        }),
      );
      continue;
    }

    result.edits_missing_claim.push(file_path);
    const warningDebounced = claimWarningDebounced(store, input.session_id, file_path, claim.code);
    recordClaimBeforeEditFailure(store, input.session_id, {
      file_path,
      tool: toolName,
      code: claim.code,
      error: claim.error,
      candidates: claim.candidates,
      policy_mode: policyMode,
      extracted_paths: files,
    });
    if (!warningDebounced)
      result.warnings.push(claimWarning(input.session_id, file_path, toolName, policyMode, claim));
  }

  return result;
}

function bridgePolicyResult(result: ClaimBeforeEditResult): ClaimBeforeEditHookResult {
  const context = claimBeforeEditWarning(result);
  const extracted_paths = result.extracted_paths;
  const warnings = result.path_extraction_warnings;
  const blocked = result.blocked_conflicts.length > 0;
  if (blocked) {
    const reason =
      context ||
      result.blocked_conflicts
        .map((conflict) => conflict.warning)
        .filter(Boolean)
        .join('\n');
    return {
      context,
      permissionDecision: 'deny',
      extracted_paths,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(reason ? { permissionDecisionReason: reason } : {}),
    };
  }
  return {
    context,
    permissionDecision: 'allow',
    extracted_paths,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function bridgePolicyMode(store: MemoryStore): BridgePolicyMode {
  const mode = (store as Partial<MemoryStore>).settings?.bridge?.policyMode;
  if (mode === 'warn' || mode === 'block-on-conflict' || mode === 'audit-only') return mode;
  return 'warn';
}

function currentClaimConflict(
  store: MemoryStore,
  session_id: string,
  scope: {
    repo_root?: string;
    branch?: string;
    cwd?: string;
    worktree_path?: string;
    agent?: string;
  },
  file_path: string,
): ClaimConflictInfo | null {
  try {
    const candidates = activeTaskCandidatesForSession(store, { session_id, ...scope });
    if (candidates.length !== 1) return null;
    const candidate = candidates[0];
    if (!candidate) return null;
    const claim = store.storage.getClaim(candidate.task_id, file_path);
    if (!claim || claim.session_id === session_id) return null;
    const classification = classifyClaimAge(claim, {
      claim_stale_minutes: store.settings.claimStaleMinutes,
    });
    const warning = `Colony ${classification.ownership_strength} claim on ${file_path} is held by ${claim.session_id}.`;
    return {
      file_path,
      task_id: candidate.task_id,
      owner: claim.session_id,
      owner_branch: candidate.branch,
      protected: false,
      conflict_strength: classification.ownership_strength,
      claimed_at: claim.claimed_at,
      age_minutes: classification.age_minutes,
      age_class: classification.age_class,
      warning,
    };
  } catch {
    return null;
  }
}

function protectedLiveClaimConflict(
  store: MemoryStore,
  session_id: string,
  scope: {
    repo_root?: string;
    branch?: string;
    cwd?: string;
    worktree_path?: string;
    agent?: string;
  },
  file_path: string,
): ClaimConflictInfo | null {
  try {
    const normalizedFilePath = normalizeClaimFilePath(file_path);
    if (!normalizedFilePath) return null;

    const candidate = singleActiveTaskCandidate(store, session_id, scope);
    const repoRoot = candidate?.repo_root ?? scope.repo_root;
    if (!repoRoot) return null;
    const normalizedRepoRoot = resolve(repoRoot);
    const tasks = store.storage.listTasks(ALL_TASKS_LIMIT);
    const conflicts: ClaimConflictInfo[] = [];

    for (const task of tasks) {
      if (resolve(task.repo_root) !== normalizedRepoRoot) continue;
      if (!isProtectedBranch(task.branch)) continue;
      for (const claim of store.storage.listClaims(task.id)) {
        if (normalizeClaimFilePath(claim.file_path) !== normalizedFilePath) continue;
        if (claim.session_id === session_id) continue;
        if (candidate?.task_id === task.id) continue;
        if (
          takeoverAssignsClaimToSession(store, {
            task_id: task.id,
            file_path: normalizedFilePath,
            target_session_id: claim.session_id,
            assigned_session_id: session_id,
          })
        ) {
          continue;
        }

        const classification = classifyClaimAge(claim, {
          claim_stale_minutes: store.settings.claimStaleMinutes,
        });
        if (!isStrongClaimAge(classification)) continue;
        conflicts.push({
          file_path: normalizedFilePath,
          task_id: task.id,
          owner: claim.session_id,
          owner_branch: task.branch,
          protected: true,
          conflict_strength: classification.ownership_strength,
          claimed_at: claim.claimed_at,
          age_minutes: classification.age_minutes,
          age_class: classification.age_class,
          warning: `Protected Colony ${classification.ownership_strength} claim on ${normalizedFilePath} is held by ${claim.session_id} on ${task.branch}. Run colony lane takeover before editing.`,
        });
      }
    }

    return conflicts.sort(compareClaimConflicts)[0] ?? null;
  } catch {
    return null;
  }
}

function singleActiveTaskCandidate(
  store: MemoryStore,
  session_id: string,
  scope: {
    repo_root?: string;
    branch?: string;
    cwd?: string;
    worktree_path?: string;
    agent?: string;
  },
): ActiveTaskCandidate | null {
  const candidates = activeTaskCandidatesForSession(store, { session_id, ...scope });
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function takeoverAssignsClaimToSession(
  store: MemoryStore,
  args: {
    task_id: number;
    file_path: string;
    target_session_id: string;
    assigned_session_id: string;
  },
): boolean {
  return store.storage.taskObservationsByKind(args.task_id, 'lane-takeover').some((row) => {
    const metadata = parseObservationMetadata(row.metadata);
    if (!metadata) return false;
    return (
      metadata.target_session_id === args.target_session_id &&
      metadata.assigned_session_id === args.assigned_session_id &&
      normalizeClaimFilePath(readString(metadata.file_path) ?? '') === args.file_path
    );
  });
}

function parseObservationMetadata(
  metadata: string | Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!metadata) return null;
  if (typeof metadata === 'object') return metadata;
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function compareClaimConflicts(left: ClaimConflictInfo, right: ClaimConflictInfo): number {
  if (left.conflict_strength !== right.conflict_strength) {
    return left.conflict_strength === 'strong' ? -1 : 1;
  }
  if (left.claimed_at !== right.claimed_at) return right.claimed_at - left.claimed_at;
  if (left.task_id !== right.task_id) return left.task_id - right.task_id;
  return left.owner.localeCompare(right.owner);
}

function isProtectedBranch(branch: string): boolean {
  return PROTECTED_BRANCHES.has(branch);
}

/**
 * Materialize a Colony task on the detected (repo_root, branch) when the
 * session has none. Without this, fresh sessions running in real worktrees
 * (e.g. codex in `agent/...` branches that share Colony as memory backend)
 * fail every auto-claim with ACTIVE_TASK_NOT_FOUND and claim-before-edit
 * telemetry sticks at 0%.
 *
 * Restricted to detected real branches on purpose — sessions with no real
 * checkout keep the existing ACTIVE_TASK_NOT_FOUND warning path so callers
 * still see actionable guidance instead of silent synthetic-task creation.
 */
function ensurePreToolUseTask(
  store: MemoryStore,
  input: PreToolUseInput,
  scope: ReturnType<typeof taskScopeForToolUse>,
): void {
  if (!scope.repo_root || !scope.branch) return;
  try {
    const activeTaskId = store.storage.findActiveTaskForSession(input.session_id);
    const activeTask = activeTaskId === undefined ? undefined : store.storage.getTask(activeTaskId);
    if (activeTask && taskMatchesToolScope(activeTask, scope)) return;
    const candidates = activeTaskCandidatesForSession(store, {
      session_id: input.session_id,
      ...scope,
    });
    if (candidates.length > 0) return;
    const ide = input.ide ?? scope.agent ?? store.storage.getSession(input.session_id)?.ide;
    const thread = TaskThread.open(store, {
      repo_root: scope.repo_root,
      branch: scope.branch,
      session_id: input.session_id,
    });
    thread.join(input.session_id, ide ?? 'unknown');
  } catch {
    // Best-effort. If task materialization fails, the existing
    // ACTIVE_TASK_NOT_FOUND warning path keeps the failure visible.
  }
}

function taskScopeForToolUse(
  store: MemoryStore,
  input: PreToolUseInput,
): {
  repo_root?: string;
  branch?: string;
  cwd?: string;
  worktree_path?: string;
  agent?: string;
} {
  try {
    const session = store.storage.getSession(input.session_id);
    const metadataScope = hookMetadataScope(input.metadata);
    const cwd = input.cwd ?? metadataScope.cwd ?? session?.cwd ?? undefined;
    const detected = cwd ? detectRepoBranch(cwd) : null;
    const metadataRepoRoot =
      readString(input.metadata?.repo_root) ?? readString(input.metadata?.repoRoot);
    const metadataBranch = readString(input.metadata?.branch);
    const explicitScope =
      detected ??
      (metadataRepoRoot && metadataBranch
        ? { repo_root: metadataRepoRoot, branch: metadataBranch }
        : null);
    const activeTask = explicitScope
      ? undefined
      : singleActiveTaskForSession(store, input.session_id);
    return {
      ...(explicitScope
        ? { repo_root: explicitScope.repo_root, branch: explicitScope.branch }
        : activeTask
          ? { repo_root: activeTask.repo_root, branch: activeTask.branch }
          : {
              ...optionalString('repo_root', metadataRepoRoot),
              ...optionalString('branch', metadataBranch),
            }),
      ...(cwd !== undefined ? { cwd } : {}),
      ...optionalString('worktree_path', metadataScope.worktree_path),
      ...(input.ide !== undefined
        ? { agent: input.ide }
        : optionalString('agent', metadataScope.agent)),
    };
  } catch {
    return {};
  }
}

function singleActiveTaskForSession(
  store: MemoryStore,
  sessionId: string,
): { repo_root: string; branch: string } | undefined {
  const candidates = activeTaskCandidatesForSession(store, { session_id: sessionId });
  if (candidates.length !== 1) return undefined;
  return store.storage.getTask(candidates[0]?.task_id ?? -1);
}

function taskMatchesToolScope(
  task: { repo_root: string; branch: string },
  scope: { repo_root?: string; branch?: string },
): boolean {
  return (
    (scope.repo_root === undefined || resolve(task.repo_root) === resolve(scope.repo_root)) &&
    (scope.branch === undefined || task.branch === scope.branch)
  );
}

function hookMetadataScope(metadata: Record<string, unknown> | undefined): {
  cwd?: string;
  worktree_path?: string;
  agent?: string;
} {
  if (!metadata) return {};
  return {
    ...optionalString('cwd', readString(metadata.cwd)),
    ...optionalString(
      'worktree_path',
      readString(metadata.worktree_path) ?? readString(metadata.worktreePath),
    ),
    ...optionalString(
      'agent',
      readString(metadata.agent) ??
        readString(metadata.agent_name) ??
        readString(metadata.agentName) ??
        readString(metadata.cli) ??
        readString(metadata.cli_name) ??
        readString(metadata.cliName),
    ),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalString<K extends string>(
  key: K,
  value: string | undefined,
): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

function recordClaimBeforeEditFailure(
  store: MemoryStore,
  session_id: string,
  metadata: {
    task_id?: number;
    file_path: string;
    tool: string;
    code: ClaimBeforeEditWarningCode;
    error: string;
    candidates: AutoClaimFailure['candidates'];
    policy_mode: BridgePolicyMode;
    conflict?: ClaimConflictInfo;
    extracted_paths?: string[];
  },
): void {
  if (metadata.code === 'COLONY_UNAVAILABLE') return;
  const sessionBindingMissing = metadata.code === 'SESSION_NOT_FOUND';
  const observationSessionId = sessionBindingMissing
    ? CLAIM_BEFORE_EDIT_FALLBACK_SESSION_ID
    : session_id;
  try {
    if (sessionBindingMissing) {
      store.startSession({
        id: CLAIM_BEFORE_EDIT_FALLBACK_SESSION_ID,
        ide: 'colony-hook',
        cwd: null,
        metadata: { source: 'pre-tool-use', purpose: 'session-binding-diagnostics' },
      });
    }
    store.addObservation({
      session_id: observationSessionId,
      kind: 'claim-before-edit',
      content: `edits_missing_claim: ${metadata.file_path}`,
      ...(metadata.task_id !== undefined ? { task_id: metadata.task_id } : {}),
      metadata: {
        kind: 'claim-before-edit',
        source: 'pre-tool-use',
        outcome: 'edits_missing_claim',
        file_path: metadata.file_path,
        extracted_paths: metadata.extracted_paths ?? [metadata.file_path],
        tool: metadata.tool,
        code: metadata.code,
        error: metadata.error,
        policy_mode: metadata.policy_mode,
        conflict: metadata.conflict !== undefined,
        conflict_strength: metadata.conflict?.conflict_strength ?? 'none',
        protected: metadata.conflict?.protected ?? false,
        owner: metadata.conflict?.owner ?? null,
        owner_branch: metadata.conflict?.owner_branch ?? null,
        warning: metadata.conflict?.warning ?? metadata.error,
        ...(sessionBindingMissing
          ? { session_binding_missing: true, original_session_id: session_id }
          : {}),
        candidates: compactCandidates(metadata.candidates),
      },
    });
  } catch {
    // Warning output is the fallback path when Colony cannot persist telemetry.
  }
}

function recordPathExtractionFailure(
  store: MemoryStore,
  session_id: string,
  metadata: {
    tool: string;
    policy_mode: BridgePolicyMode;
    warnings: string[];
    scope: {
      repo_root?: string;
      branch?: string;
      cwd?: string;
      worktree_path?: string;
      agent?: string;
    };
  },
): void {
  try {
    const taskId = activeTaskIdForScope(store, session_id, metadata.scope);
    store.addObservation({
      session_id,
      kind: 'claim-before-edit',
      content: `path_extraction_failed: ${metadata.tool}`,
      ...(taskId !== undefined ? { task_id: taskId } : {}),
      metadata: {
        kind: 'claim-before-edit',
        source: 'pre-tool-use',
        outcome: 'path_extraction_failed',
        file_path: null,
        extracted_paths: [],
        tool: metadata.tool,
        code: 'PATH_EXTRACTION_FAILED',
        policy_mode: metadata.policy_mode,
        path_extraction_failed: true,
        path_extraction_warning: metadata.warnings[0] ?? null,
        path_extraction_warnings: metadata.warnings,
        warning: metadata.warnings[0] ?? null,
        repo_root: metadata.scope.repo_root ?? null,
        branch: metadata.scope.branch ?? null,
        cwd: metadata.scope.cwd ?? null,
        worktree_path: metadata.scope.worktree_path ?? null,
        agent: metadata.scope.agent ?? null,
      },
    });
  } catch {
    // Context warnings still carry the failure when telemetry persistence fails.
  }
}

function activeTaskIdForScope(
  store: MemoryStore,
  session_id: string,
  scope: {
    repo_root?: string;
    branch?: string;
    cwd?: string;
    worktree_path?: string;
    agent?: string;
  },
): number | undefined {
  const active = store.storage.findActiveTaskForSession(session_id);
  if (active !== undefined) return active;
  if (scope.repo_root && scope.branch) {
    const task = store.storage.findTaskByBranch(scope.repo_root, scope.branch);
    if (task) return task.id;
  }
  const candidates = activeTaskCandidatesForSession(store, { session_id, ...scope });
  return candidates.length === 1 ? candidates[0]?.task_id : undefined;
}

function compactCandidates(candidates: AutoClaimFailure['candidates']): Array<{
  task_id: number;
  title: string;
  repo_root: string;
  branch: string;
  status: string;
  updated_at: number;
  active_files?: string[];
}> {
  return candidates.slice(0, 5).map((candidate) => ({
    task_id: candidate.task_id,
    title: candidate.title,
    repo_root: candidate.repo_root,
    branch: candidate.branch,
    status: candidate.status,
    updated_at: candidate.updated_at,
    ...(candidate.active_files !== undefined ? { active_files: candidate.active_files } : {}),
  }));
}

function recordClaimBeforeEdit(
  store: MemoryStore,
  session_id: string,
  task_id: number,
  metadata: {
    outcome: 'edits_with_claim' | 'edits_missing_claim' | 'auto_claimed_before_edit';
    file_path: string;
    tool: string;
    policy_mode: BridgePolicyMode;
    other_session?: string;
    claim_observation_id?: number;
    conflict?: ClaimConflictInfo;
    extracted_paths?: string[];
  },
): void {
  store.addObservation({
    session_id,
    kind: 'claim-before-edit',
    content: `${metadata.outcome}: ${metadata.file_path}`,
    task_id,
    metadata: {
      kind: 'claim-before-edit',
      source: 'pre-tool-use',
      ...metadata,
      extracted_paths: metadata.extracted_paths ?? [metadata.file_path],
      conflict: metadata.conflict !== undefined,
      conflict_strength: metadata.conflict?.conflict_strength ?? 'none',
      protected: metadata.conflict?.protected ?? false,
      owner: metadata.conflict?.owner ?? null,
      owner_branch: metadata.conflict?.owner_branch ?? null,
      warning: metadata.conflict?.warning ?? null,
    },
  });
}

function claimBeforeEditWarning(result: ClaimBeforeEditResult): string {
  if (result.policy_mode === 'audit-only') return '';
  return result.warnings.map((warning) => JSON.stringify(warning)).join('\n');
}

type ClaimWarningInput = Pick<AutoClaimFailure, 'error' | 'candidates' | 'creation_guidance'> & {
  ok?: false;
  code: ClaimBeforeEditWarningCode;
  conflict?: ClaimConflictInfo;
};

function claimWarning(
  session_id: string,
  file_path: string,
  tool_name: string,
  policyMode: BridgePolicyMode,
  claim: ClaimWarningInput,
): ClaimBeforeEditFallbackWarning {
  const candidates = compactCandidates(claim.candidates);
  // Spell out the exact tool call the agent should make next. When there is
  // exactly one candidate task we substitute its id; ambiguous candidates and
  // no-candidate cases keep a placeholder so the agent picks consciously.
  const taskRef =
    candidates.length === 1
      ? String(candidates[0]?.task_id ?? '<task_id>')
      : candidates.length > 0
        ? '<candidate.task_id>'
        : '<task_id>';
  const next_call = `mcp__colony__task_claim_file({ task_id: ${taskRef}, session_id: "${session_id}", file_path: "${file_path}", note: "pre-edit claim" })`;
  const tool = tool_name || 'edit tool';
  const conflict = claim.conflict;
  const message =
    claim.code === 'LIVE_FILE_CONTENTION' && conflict
      ? [
          `${conflict.protected ? 'Protected Colony' : 'Colony'} ${conflict.conflict_strength} claim conflict before ${tool} on ${file_path}.`,
          `owner=${conflict.owner}`,
          conflict.owner_branch ? `owner_branch=${conflict.owner_branch}` : '',
          `policy=${policyMode}`,
          `warning=${conflict.warning}`,
        ]
          .filter(Boolean)
          .join('\n')
      : [
          `Missing Colony claim before ${tool} on ${file_path}.`,
          `reason=${claim.code}: ${claim.error}`,
          `next=${next_call}`,
          candidates.length > 0 ? `candidates=${JSON.stringify(candidates)}` : '',
        ]
          .filter(Boolean)
          .join('\n');
  return {
    code: claim.code,
    message,
    ...(conflict
      ? {
          warning: conflict.warning,
          policy_mode: policyMode,
          conflict: true,
          conflict_strength: conflict.conflict_strength,
          protected: conflict.protected ?? false,
          owner: conflict.owner,
          owner_branch: conflict.owner_branch ?? null,
        }
      : {}),
    next_tool: 'task_claim_file',
    next_call,
    suggested_args: {
      task_id: candidates.length > 0 ? '<candidate.task_id>' : '<task_id>',
      session_id,
      file_path,
      note: 'pre-edit claim',
    },
    ...(candidates.length > 0 ? { candidates } : {}),
    ...(claim.creation_guidance !== undefined
      ? { creation_guidance: claim.creation_guidance }
      : {}),
  };
}

function claimWarningDebounced(
  store: MemoryStore,
  session_id: string,
  file_path: string,
  code: AutoClaimFailureCode,
): boolean {
  const now = Date.now();
  const cutoff = now - CLAIM_WARNING_DEBOUNCE_MS;
  const key = `${session_id}\0${file_path}\0${code}`;
  const claimWarningDebounce = claimWarningDebounceByStore.get(store) ?? new Map<string, number>();
  claimWarningDebounceByStore.set(store, claimWarningDebounce);
  const lastEmittedAt = claimWarningDebounce.get(key);
  claimWarningDebounce.set(key, now);
  if (lastEmittedAt !== undefined && lastEmittedAt >= cutoff) return true;
  try {
    return store.timeline(session_id, undefined, 20).some((row) => {
      if (row.kind !== 'claim-before-edit' || row.ts < cutoff) return false;
      const metadata = row.metadata ?? {};
      return (
        metadata.outcome === 'edits_missing_claim' &&
        metadata.file_path === file_path &&
        metadata.code === code
      );
    });
  } catch {
    return false;
  }
}
