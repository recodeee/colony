import { isAbsolute, relative, resolve } from 'node:path';
import { type MemoryStore, detectRepoBranch } from '@colony/core';

export interface ActiveTaskCandidate {
  task_id: number;
  title: string;
  repo_root: string;
  branch: string;
  status: string;
  updated_at: number;
  agent: string;
}

type ActiveTaskMatch = 'session_id' | 'branch_repo_root' | 'cwd' | 'agent';

interface MatchedActiveTaskCandidate extends ActiveTaskCandidate {
  matched_by: ActiveTaskMatch;
}

export type AutoClaimObservationKind = 'claim' | 'auto-claim';
export type AutoClaimFailureCode =
  | 'ACTIVE_TASK_NOT_FOUND'
  | 'AMBIGUOUS_ACTIVE_TASK'
  | 'SESSION_NOT_FOUND'
  | 'COLONY_UNAVAILABLE';

export interface AutoClaimFileForSessionInput {
  session_id: string;
  repo_root?: string;
  branch?: string;
  cwd?: string;
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
      task_id: number;
      observation_id: number | null;
      candidate: ActiveTaskCandidate;
      previous_claim_session?: string;
    }
  | {
      ok: false;
      code: AutoClaimFailureCode;
      error: string;
      creation_guidance?: string;
      candidates: ActiveTaskCandidate[];
    };

export function activeTaskCandidatesForSession(
  store: MemoryStore,
  opts: { session_id: string; repo_root?: string; branch?: string; cwd?: string; agent?: string },
): ActiveTaskCandidate[] {
  return activeTaskMatchesForSession(store, opts).map(({ matched_by: _matched_by, ...row }) => row);
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
    if (!store.storage.getSession(input.session_id)) {
      return {
        ok: false,
        code: 'SESSION_NOT_FOUND',
        error: `Colony session ${input.session_id} was not found`,
        candidates: [],
      };
    }

    const candidates = activeTaskCandidatesForSession(store, input);
    if (candidates.length !== 1) {
      const code = candidates.length === 0 ? 'ACTIVE_TASK_NOT_FOUND' : 'AMBIGUOUS_ACTIVE_TASK';
      return {
        ok: false,
        code,
        error:
          code === 'ACTIVE_TASK_NOT_FOUND'
            ? 'no active Colony task matched session/repo/branch'
            : 'multiple active Colony tasks matched session/repo/branch',
        ...(code === 'ACTIVE_TASK_NOT_FOUND'
          ? {
              creation_guidance:
                'Create or join a Colony task for this session with cwd/repo_root/branch, then retry the edit or call task_claim_file with an explicit task_id.',
            }
          : {}),
        candidates,
      };
    }

    const candidate = candidates[0];
    if (!candidate) throw new Error('active task resolution lost its only candidate');
    ensureTaskParticipant(store, candidate, input.session_id);

    const existing = store.storage.getClaim(candidate.task_id, input.file_path);
    if (existing?.session_id === input.session_id) {
      return {
        ok: true,
        status: 'already_claimed',
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
          content: `${input.session_id} edited ${input.file_path} while ${previousClaimSession} held the claim`,
          task_id: candidate.task_id,
          metadata: {
            source: input.source ?? 'autoClaimFileForSession',
            file_path: input.file_path,
            ...(input.tool !== undefined ? { tool: input.tool } : {}),
            other_session: previousClaimSession,
          },
        });
      }

      store.storage.claimFile({
        task_id: candidate.task_id,
        file_path: input.file_path,
        session_id: input.session_id,
      });
      return store.addObservation({
        session_id: input.session_id,
        kind,
        content: claimContent(kind, input),
        task_id: candidate.task_id,
        metadata: {
          kind,
          source: input.source ?? 'autoClaimFileForSession',
          file_path: input.file_path,
          resolved_by: input.resolved_by ?? 'autoClaimFileForSession',
          ...(input.auto_claimed_before_edit === true ? { auto_claimed_before_edit: true } : {}),
          ...(input.tool !== undefined ? { tool: input.tool } : {}),
        },
      });
    });

    return {
      ok: true,
      status: 'claimed',
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
      error: err instanceof Error ? err.message : String(err),
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

function activeTaskMatchesForSession(
  store: MemoryStore,
  opts: { session_id: string; repo_root?: string; branch?: string; cwd?: string; agent?: string },
): MatchedActiveTaskCandidate[] {
  const session = store.storage.getSession(opts.session_id);
  const cwd = opts.cwd ?? session?.cwd ?? undefined;
  const detected = cwd ? detectRepoBranch(cwd) : null;
  const scopedRepoRoot = opts.repo_root ?? detected?.repo_root;
  const scopedBranch = opts.branch ?? detected?.branch;
  const agent = normalizeAgent(opts.agent ?? session?.ide ?? opts.session_id);
  const tasks = store.storage.listTasks(2000).filter((task) => isActiveStatus(task.status));

  const sessionMatches = matchesForTasks(
    store,
    tasks.filter((task) => taskMatchesScope(task, scopedRepoRoot, scopedBranch)),
    agent,
    'session_id',
    (participants) =>
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

  if (cwd !== undefined) {
    const cwdMatches = matchesForTasks(
      store,
      tasks.filter((task) => samePathOrChild(task.repo_root, cwd)),
      agent,
      'cwd',
    );
    if (cwdMatches.length > 0) return sortCandidates(cwdMatches);
  }

  if (scopedBranch !== undefined) return [];

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
      return {
        task_id: task.id,
        title: task.title,
        repo_root: task.repo_root,
        branch: task.branch,
        status: task.status,
        updated_at: task.updated_at,
        agent,
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

function samePathOrChild(repoRoot: string, cwd: string): boolean {
  const rel = relative(resolve(repoRoot), resolve(cwd));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
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
