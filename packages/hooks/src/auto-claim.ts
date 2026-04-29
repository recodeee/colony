import { isAbsolute, relative, resolve } from 'node:path';
import { type MemoryStore, detectRepoBranch, normalizeClaimPath } from '@colony/core';

export interface ActiveTaskCandidate {
  task_id: number;
  title: string;
  repo_root: string;
  branch: string;
  status: string;
  updated_at: number;
  agent: string;
  active_files?: string[];
}

type ActiveTaskMatch = 'session_id' | 'branch_repo_root' | 'worktree' | 'agent';

interface MatchedActiveTaskCandidate extends ActiveTaskCandidate {
  matched_by: ActiveTaskMatch;
}

export type ActiveTaskBindingStatus = 'bound' | 'ambiguous' | 'not_found';

export interface ActiveTaskSuggestedAction {
  create_or_bind_task: string;
  manual_claim_if_task_id_known: string;
}

export type ActiveTaskBindingResult =
  | {
      status: 'bound';
      candidate: ActiveTaskCandidate;
      matched_by: ActiveTaskMatch;
    }
  | {
      status: 'ambiguous';
      candidates: ActiveTaskCandidate[];
    }
  | {
      status: 'not_found';
      candidates: [];
      suggested_action: ActiveTaskSuggestedAction;
    };

export type AutoClaimObservationKind = 'claim' | 'auto-claim';
export type AutoClaimFailureCode =
  | 'ACTIVE_TASK_NOT_FOUND'
  | 'AMBIGUOUS_ACTIVE_TASK'
  | 'SESSION_NOT_FOUND'
  | 'COLONY_UNAVAILABLE'
  | 'UNCLAIMABLE_FILE_PATH';

export interface AutoClaimFileForSessionInput {
  session_id: string;
  repo_root?: string;
  branch?: string;
  cwd?: string;
  worktree_path?: string;
  agent?: string;
  file_path: string;
  note?: string;
  source?: string;
  tool?: string;
  observation_kind?: AutoClaimObservationKind;
  record_conflict?: boolean;
  resolved_by?: string;
  auto_claimed_before_edit?: boolean;
}

export interface AutoClaimFileForSessionCall extends AutoClaimFileForSessionInput {
  store: MemoryStore;
}

export type AutoClaimFileBeforeEditInput = AutoClaimFileForSessionInput;
export type AutoClaimFileBeforeEditCall = AutoClaimFileForSessionCall;

export type AutoClaimFileForSessionResult =
  | {
      ok: true;
      status: 'claimed' | 'already_claimed';
      resolution: 'bound';
      matched_by: ActiveTaskMatch;
      task_id: number;
      observation_id: number | null;
      candidate: ActiveTaskCandidate;
      previous_claim_session?: string;
    }
  | {
      ok: false;
      code: AutoClaimFailureCode;
      resolution: 'ambiguous' | 'not_found';
      error: string;
      creation_guidance?: string;
      suggested_action?: ActiveTaskSuggestedAction;
      candidates: ActiveTaskCandidate[];
    };

const ACTIVE_TASK_NOT_FOUND_SUGGESTED_ACTION: ActiveTaskSuggestedAction = {
  create_or_bind_task: 'Create or bind a Colony task for this session/repo/branch.',
  manual_claim_if_task_id_known: 'Manually call task_claim_file if task_id is already known.',
};

export function activeTaskCandidatesForSession(
  store: MemoryStore,
  opts: {
    session_id: string;
    repo_root?: string;
    branch?: string;
    cwd?: string;
    worktree_path?: string;
    agent?: string;
  },
): ActiveTaskCandidate[] {
  const resolution = resolveActiveTaskBinding(store, opts);
  if (resolution.status === 'bound') return [resolution.candidate];
  if (resolution.status === 'ambiguous') return resolution.candidates;
  return [];
}

export function resolveActiveTaskBinding(
  store: MemoryStore,
  opts: {
    session_id: string;
    repo_root?: string;
    branch?: string;
    cwd?: string;
    worktree_path?: string;
    agent?: string;
  },
): ActiveTaskBindingResult {
  const candidates = activeTaskMatchesForSession(store, opts);
  if (candidates.length === 1) {
    const candidate = candidates[0];
    if (!candidate) throw new Error('active task resolution lost its only candidate');
    const { matched_by, ...row } = candidate;
    return { status: 'bound', candidate: row, matched_by };
  }
  if (candidates.length > 1) {
    return {
      status: 'ambiguous',
      candidates: candidates.map(({ matched_by: _matched_by, ...row }) => row),
    };
  }
  return {
    status: 'not_found',
    candidates: [],
    suggested_action: ACTIVE_TASK_NOT_FOUND_SUGGESTED_ACTION,
  };
}

export function autoClaimFileForSession(
  input: AutoClaimFileForSessionCall,
): AutoClaimFileForSessionResult;
export function autoClaimFileForSession(
  store: MemoryStore,
  input: AutoClaimFileForSessionInput,
): AutoClaimFileForSessionResult;
export function autoClaimFileForSession(
  storeOrInput: MemoryStore | AutoClaimFileForSessionCall,
  maybeInput?: AutoClaimFileForSessionInput,
): AutoClaimFileForSessionResult {
  const store = maybeInput
    ? (storeOrInput as MemoryStore)
    : (storeOrInput as AutoClaimFileForSessionCall).store;
  const input = maybeInput ?? (storeOrInput as AutoClaimFileForSessionCall);
  try {
    const session = store.storage.getSession(input.session_id);
    const binding = resolveActiveTaskBinding(store, input);
    if (binding.status !== 'bound') {
      const code =
        session === undefined && binding.status === 'not_found'
          ? 'SESSION_NOT_FOUND'
          : binding.status === 'not_found'
            ? 'ACTIVE_TASK_NOT_FOUND'
            : 'AMBIGUOUS_ACTIVE_TASK';
      return {
        ok: false,
        code,
        resolution: binding.status,
        error:
          code === 'SESSION_NOT_FOUND'
            ? `Colony session ${input.session_id} was not found`
            : code === 'ACTIVE_TASK_NOT_FOUND'
              ? 'no active Colony task matched session/repo/branch'
              : 'multiple active Colony tasks matched session/repo/branch',
        ...(code === 'ACTIVE_TASK_NOT_FOUND'
          ? binding.status === 'not_found'
            ? {
                creation_guidance:
                  'Create or join a Colony task for this session with cwd/repo_root/branch, then retry the edit or call task_claim_file with an explicit task_id.',
                suggested_action: binding.suggested_action,
              }
            : {}
          : code === 'SESSION_NOT_FOUND'
            ? { suggested_action: ACTIVE_TASK_NOT_FOUND_SUGGESTED_ACTION }
            : {}),
        candidates: binding.candidates,
      };
    }

    const candidate = binding.candidate;
    const normalizedFilePath = normalizeClaimPath({
      repo_root: candidate.repo_root,
      cwd: input.cwd ?? input.worktree_path,
      file_path: input.file_path,
    });
    if (normalizedFilePath === null) {
      return {
        ok: false,
        code: 'UNCLAIMABLE_FILE_PATH',
        resolution: 'not_found',
        error: `file path is not claimable: ${input.file_path}`,
        candidates: [candidate],
      };
    }
    const normalizedInput = { ...input, file_path: normalizedFilePath };
    ensureAutoClaimSession(store, input, candidate);
    ensureTaskParticipant(store, candidate, input.session_id);

    const existing = store.storage.getClaim(candidate.task_id, normalizedFilePath);
    if (existing?.session_id === input.session_id) {
      return {
        ok: true,
        status: 'already_claimed',
        resolution: 'bound',
        matched_by: binding.matched_by,
        task_id: candidate.task_id,
        observation_id: null,
        candidate,
      };
    }

    const previousClaimSession = existing?.session_id;
    const kind = input.observation_kind ?? 'claim';
    const observationId = store.storage.transaction(() => {
      if (previousClaimSession && input.record_conflict === true) {
        store.addObservation({
          session_id: input.session_id,
          kind: 'claim-conflict',
          content: `${input.session_id} edited ${normalizedFilePath} while ${previousClaimSession} held the claim`,
          task_id: candidate.task_id,
          metadata: {
            source: input.source ?? 'autoClaimFileForSession',
            file_path: normalizedFilePath,
            ...(input.tool !== undefined ? { tool: input.tool } : {}),
            other_session: previousClaimSession,
          },
        });
      }

      store.storage.claimFile({
        task_id: candidate.task_id,
        file_path: normalizedFilePath,
        session_id: input.session_id,
      });
      return store.addObservation({
        session_id: input.session_id,
        kind,
        content: claimContent(kind, normalizedInput),
        task_id: candidate.task_id,
        metadata: {
          kind,
          source: input.source ?? 'autoClaimFileForSession',
          file_path: normalizedFilePath,
          resolved_by: input.resolved_by ?? 'autoClaimFileForSession',
          ...(input.auto_claimed_before_edit === true ? { auto_claimed_before_edit: true } : {}),
          ...(input.tool !== undefined ? { tool: input.tool } : {}),
        },
      });
    });

    return {
      ok: true,
      status: 'claimed',
      resolution: 'bound',
      matched_by: binding.matched_by,
      task_id: candidate.task_id,
      observation_id: observationId,
      candidate,
      ...(previousClaimSession !== undefined
        ? { previous_claim_session: previousClaimSession }
        : {}),
    };
  } catch (err) {
    return {
      ok: false,
      code: 'COLONY_UNAVAILABLE',
      resolution: 'not_found',
      error: err instanceof Error ? err.message : String(err),
      suggested_action: ACTIVE_TASK_NOT_FOUND_SUGGESTED_ACTION,
      candidates: [],
    };
  }
}

function isActiveStatus(status: string): boolean {
  return !['completed', 'archived', 'auto-archived', 'abandoned'].includes(status.toLowerCase());
}

function ensureTaskParticipant(
  store: MemoryStore,
  candidate: ActiveTaskCandidate,
  session_id: string,
): void {
  const boundAgent = store.storage.getParticipantAgent(candidate.task_id, session_id);
  if (boundAgent) return;
  store.storage.addTaskParticipant({
    task_id: candidate.task_id,
    session_id,
    agent: candidate.agent,
  });
}

function ensureAutoClaimSession(
  store: MemoryStore,
  input: AutoClaimFileForSessionInput,
  candidate: ActiveTaskCandidate,
): void {
  if (store.storage.getSession(input.session_id)) return;
  const agent = normalizeAgent(input.agent ?? candidate.agent ?? input.session_id);
  store.startSession({
    id: input.session_id,
    ide: agent === 'claude' ? 'claude-code' : agent,
    cwd: input.cwd ?? input.worktree_path ?? null,
    metadata: {
      source: 'auto-claim',
      agent,
      repo_root: input.repo_root ?? candidate.repo_root,
      branch: input.branch ?? candidate.branch,
      worktree_path: input.worktree_path ?? input.cwd,
    },
  });
}

function activeTaskMatchesForSession(
  store: MemoryStore,
  opts: {
    session_id: string;
    repo_root?: string;
    branch?: string;
    cwd?: string;
    worktree_path?: string;
    agent?: string;
  },
): MatchedActiveTaskCandidate[] {
  const session = store.storage.getSession(opts.session_id);
  const metadataScope = sessionMetadataScope(session?.metadata);
  const cwd = opts.cwd ?? metadataScope.cwd ?? session?.cwd ?? undefined;
  const detected = cwd ? detectRepoBranch(cwd) : null;
  const scopedRepoRoot = opts.repo_root ?? detected?.repo_root ?? metadataScope.repo_root;
  const scopedBranch = opts.branch ?? detected?.branch ?? metadataScope.branch;
  const worktreePath = opts.worktree_path ?? metadataScope.worktree_path;
  const worktreeScopes = uniqueStrings([worktreePath, cwd]);
  const agent = normalizeAgent(
    opts.agent ?? metadataScope.agent ?? session?.ide ?? opts.session_id,
  );
  const tasks = store.storage.listTasks(2000).filter((task) => isActiveStatus(task.status));

  const sessionMatches = matchesForTasks(store, tasks, agent, 'session_id', (participants) =>
    participants.find((row) => row.session_id === opts.session_id && row.left_at === null),
  );
  if (sessionMatches.length > 0) return sortCandidates(sessionMatches);

  if (scopedRepoRoot !== undefined && scopedBranch !== undefined) {
    const branchMatches = matchesForTasks(
      store,
      tasks.filter((task) => taskMatchesScope(task, scopedRepoRoot, scopedBranch)),
      agent,
      'branch_repo_root',
    );
    if (branchMatches.length > 0) return sortCandidates(branchMatches);
  }

  if (worktreeScopes.length > 0) {
    const worktreeMatches = matchesForTasks(
      store,
      tasks.filter((task) => taskMatchesWorktreeScope(task, worktreeScopes)),
      agent,
      'worktree',
    );
    if (worktreeMatches.length > 0) return sortCandidates(worktreeMatches);
  }

  const agentMatches = matchesForTasks(
    store,
    scopedRepoRoot === undefined
      ? tasks
      : tasks.filter((task) => resolve(task.repo_root) === resolve(scopedRepoRoot)),
    agent,
    'agent',
    (participants) =>
      participants.find((row) => row.left_at === null && normalizeAgent(row.agent) === agent),
  );
  return sortCandidates(agentMatches);
}

function matchesForTasks(
  store: MemoryStore,
  tasks: Array<{
    id: number;
    title: string;
    repo_root: string;
    branch: string;
    status: string;
    updated_at: number;
  }>,
  fallbackAgent: string,
  matched_by: ActiveTaskMatch,
  participantSelector?: (
    participants: Array<{ session_id: string; agent: string; left_at: number | null }>,
  ) => { agent: string } | undefined,
): MatchedActiveTaskCandidate[] {
  return tasks
    .map((task) => {
      const participants = store.storage.listParticipants(task.id);
      const participant = participantSelector?.(participants);
      if (participantSelector && !participant) return null;
      const agent =
        participant?.agent ??
        participants.find(
          (row) => row.left_at === null && normalizeAgent(row.agent) === fallbackAgent,
        )?.agent ??
        fallbackAgent;
      const activeFiles = store.storage
        .listClaims(task.id)
        .map((claim) => claim.file_path)
        .slice(0, 5);
      return {
        task_id: task.id,
        title: task.title,
        repo_root: task.repo_root,
        branch: task.branch,
        status: task.status,
        updated_at: task.updated_at,
        agent,
        ...(activeFiles.length > 0 ? { active_files: activeFiles } : {}),
        matched_by,
      };
    })
    .filter((row): row is MatchedActiveTaskCandidate => row !== null);
}

function taskMatchesScope(
  task: { repo_root: string; branch: string },
  repo_root: string | undefined,
  branch: string | undefined,
): boolean {
  if (repo_root !== undefined && resolve(task.repo_root) !== resolve(repo_root)) return false;
  if (branch !== undefined && task.branch !== branch) return false;
  return true;
}

function taskMatchesWorktreeScope(
  task: { repo_root: string; branch: string },
  worktreeScopes: string[],
): boolean {
  return worktreeScopes.some((scope) => samePathOrChild(task.repo_root, scope));
}

function samePathOrChild(repoRoot: string, cwd: string): boolean {
  const rel = relative(resolve(repoRoot), resolve(cwd));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function sessionMetadataScope(metadata: string | null | undefined): {
  repo_root?: string;
  branch?: string;
  cwd?: string;
  worktree_path?: string;
  agent?: string;
} {
  const parsed = parseMetadata(metadata);
  if (!parsed) return {};
  return {
    ...optionalString('repo_root', readString(parsed.repo_root) ?? readString(parsed.repoRoot)),
    ...optionalString('branch', readString(parsed.branch)),
    ...optionalString('cwd', readString(parsed.cwd)),
    ...optionalString(
      'worktree_path',
      readString(parsed.worktree_path) ?? readString(parsed.worktreePath),
    ),
    ...optionalString(
      'agent',
      readString(parsed.agent) ??
        readString(parsed.agent_name) ??
        readString(parsed.agentName) ??
        readString(parsed.cli) ??
        readString(parsed.cli_name) ??
        readString(parsed.cliName),
    ),
  };
}

function parseMetadata(metadata: string | null | undefined): Record<string, unknown> | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))];
}

function normalizeAgent(value: string | undefined): string {
  const raw = (value ?? 'agent').toLowerCase();
  const prefix = raw.includes('@')
    ? raw.split('@')[0]
    : raw.includes('/')
      ? raw.split('/')[0]
      : raw;
  if (prefix === 'claude-code') return 'claude';
  if (prefix === 'claude' || prefix === 'codex') return prefix;
  return prefix || 'agent';
}

function sortCandidates<T extends ActiveTaskCandidate>(candidates: T[]): T[] {
  return candidates.sort((a, b) => b.updated_at - a.updated_at);
}

export function autoClaimFileBeforeEdit(
  input: AutoClaimFileBeforeEditCall,
): AutoClaimFileForSessionResult;
export function autoClaimFileBeforeEdit(
  store: MemoryStore,
  input: AutoClaimFileBeforeEditInput,
): AutoClaimFileForSessionResult;
export function autoClaimFileBeforeEdit(
  storeOrInput: MemoryStore | AutoClaimFileBeforeEditCall,
  maybeInput?: AutoClaimFileBeforeEditInput,
): AutoClaimFileForSessionResult {
  const store = maybeInput
    ? (storeOrInput as MemoryStore)
    : (storeOrInput as AutoClaimFileBeforeEditCall).store;
  const input = maybeInput ?? (storeOrInput as AutoClaimFileBeforeEditCall);
  const result = autoClaimFileForSession(store, {
    ...input,
    source: input.source ?? 'autoClaimFileBeforeEdit',
    resolved_by: input.resolved_by ?? 'autoClaimFileBeforeEdit',
    auto_claimed_before_edit: true,
  });
  return result;
}

function claimContent(kind: AutoClaimObservationKind, input: AutoClaimFileForSessionInput): string {
  if (kind === 'auto-claim') {
    const tool = input.tool ?? 'unknown';
    return `${input.session_id} auto-claimed ${input.file_path} after ${tool}`;
  }
  return input.note ? `claim ${input.file_path} - ${input.note}` : `claim ${input.file_path}`;
}
