import { resolve } from 'node:path';
import type { MemoryStore } from '@colony/core';

export interface ActiveTaskCandidate {
  task_id: number;
  title: string;
  repo_root: string;
  branch: string;
  status: string;
  updated_at: number;
  agent: string;
}

export type AutoClaimObservationKind = 'claim' | 'auto-claim';

export interface AutoClaimFileForSessionInput {
  session_id: string;
  repo_root?: string;
  branch?: string;
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
      code: 'ACTIVE_TASK_NOT_FOUND' | 'AMBIGUOUS_ACTIVE_TASK';
      error: string;
      candidates: ActiveTaskCandidate[];
    };

export function activeTaskCandidatesForSession(
  store: MemoryStore,
  opts: { session_id: string; repo_root?: string; branch?: string },
): ActiveTaskCandidate[] {
  const candidates: ActiveTaskCandidate[] = [];
  for (const task of store.storage.listTasks(2000)) {
    if (opts.repo_root !== undefined && resolve(task.repo_root) !== resolve(opts.repo_root)) {
      continue;
    }
    if (opts.branch !== undefined && task.branch !== opts.branch) continue;
    if (!isActiveStatus(task.status)) continue;
    const participant = store.storage
      .listParticipants(task.id)
      .find((row) => row.session_id === opts.session_id && row.left_at === null);
    if (!participant) continue;
    candidates.push({
      task_id: task.id,
      title: task.title,
      repo_root: task.repo_root,
      branch: task.branch,
      status: task.status,
      updated_at: task.updated_at,
      agent: participant.agent,
    });
  }
  return candidates.sort((a, b) => b.updated_at - a.updated_at);
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
      candidates,
    };
  }

  const candidate = candidates[0];
  if (!candidate) throw new Error('active task resolution lost its only candidate');

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
    ...(previousClaimSession !== undefined ? { previous_claim_session: previousClaimSession } : {}),
  };
}

function isActiveStatus(status: string): boolean {
  return !['completed', 'archived', 'auto-archived', 'abandoned'].includes(status.toLowerCase());
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
