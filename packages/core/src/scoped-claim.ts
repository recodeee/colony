import { resolve } from 'node:path';
import type { TaskClaimRow, TaskRow } from '@colony/storage';
import { classifyClaimAge, isStrongClaimAge } from './claim-age.js';
import type { MemoryStore } from './memory-store.js';

export type GuardedClaimStatus =
  | 'claimed'
  | 'refreshed_same_session'
  | 'refreshed_same_lane'
  | 'takeover_recommended'
  | 'blocked_active_owner'
  | 'invalid_path'
  | 'task_not_found';

export interface GuardedClaimResult {
  status: GuardedClaimStatus;
  task_id: number;
  file_path: string;
  claim_task_id?: number;
  owner_session_id?: string;
  owner_agent?: string | undefined;
  owner_active?: boolean;
  recommendation?: string;
}

export function guardedClaimFile(
  store: MemoryStore,
  args: {
    task_id: number;
    file_path: string;
    session_id: string;
    agent?: string;
  },
): GuardedClaimResult {
  const task = store.storage.getTask(args.task_id);
  if (!task) {
    return { status: 'task_not_found', task_id: args.task_id, file_path: args.file_path };
  }
  const filePath = store.storage.normalizeTaskFilePath(args.task_id, args.file_path);
  if (filePath === null) {
    return { status: 'invalid_path', task_id: args.task_id, file_path: args.file_path };
  }

  const existing = findScopedClaim(store, task, filePath);
  if (!existing) {
    store.storage.claimFile({
      task_id: args.task_id,
      file_path: filePath,
      session_id: args.session_id,
    });
    return {
      status: 'claimed',
      task_id: args.task_id,
      file_path: filePath,
      claim_task_id: args.task_id,
    };
  }

  const owner = claimOwner(store, existing.claim);
  const requesterAgent = normalizeAgent(
    args.agent ??
      store.storage.getParticipantAgent(args.task_id, args.session_id) ??
      store.storage.getSession(args.session_id)?.ide,
  );
  const sameSession = existing.claim.session_id === args.session_id;
  const sameLane =
    !sameSession &&
    owner.active &&
    owner.agent !== undefined &&
    requesterAgent !== undefined &&
    owner.agent === requesterAgent;

  if (!owner.strong && existing.claim.task_id === args.task_id) {
    store.storage.claimFile({
      task_id: args.task_id,
      file_path: filePath,
      session_id: args.session_id,
    });
    return {
      status: 'claimed',
      task_id: args.task_id,
      file_path: filePath,
      claim_task_id: args.task_id,
      owner_session_id: existing.claim.session_id,
      owner_agent: owner.agent,
      owner_active: false,
    };
  }

  if (sameSession || sameLane) {
    store.storage.claimFile({
      task_id: existing.claim.task_id,
      file_path: existing.claim.file_path,
      session_id: args.session_id,
    });
    return {
      status: sameSession ? 'refreshed_same_session' : 'refreshed_same_lane',
      task_id: args.task_id,
      file_path: filePath,
      claim_task_id: existing.claim.task_id,
      owner_session_id: existing.claim.session_id,
      owner_agent: owner.agent,
      owner_active: owner.active,
    };
  }

  if (!owner.active || !owner.strong) {
    return {
      status: 'takeover_recommended',
      task_id: args.task_id,
      file_path: filePath,
      claim_task_id: existing.claim.task_id,
      owner_session_id: existing.claim.session_id,
      owner_agent: owner.agent,
      owner_active: false,
      recommendation: `release or take over inactive claim ${existing.claim.session_id} on ${filePath} before claiming`,
    };
  }

  return {
    status: 'blocked_active_owner',
    task_id: args.task_id,
    file_path: filePath,
    claim_task_id: existing.claim.task_id,
    owner_session_id: existing.claim.session_id,
    owner_agent: owner.agent,
    owner_active: true,
    recommendation: `request handoff or explicit takeover from active owner ${existing.claim.session_id} before claiming ${filePath}`,
  };
}

function findScopedClaim(
  store: MemoryStore,
  task: TaskRow,
  filePath: string,
): { task: TaskRow; claim: TaskClaimRow } | null {
  const tasks = store.storage
    .listTasks(1_000_000)
    .filter(
      (candidate) =>
        resolve(candidate.repo_root) === resolve(task.repo_root) &&
        candidate.branch === task.branch &&
        candidate.status !== 'completed' &&
        candidate.status !== 'archived' &&
        candidate.status !== 'auto-archived',
    );

  for (const candidate of tasks) {
    for (const claim of store.storage.listClaims(candidate.id)) {
      if (claim.state !== 'active') continue;
      const normalized = store.storage.normalizeTaskFilePath(candidate.id, claim.file_path);
      if (normalized === filePath) return { task: candidate, claim };
    }
  }
  return null;
}

function claimOwner(
  store: MemoryStore,
  claim: TaskClaimRow,
): { agent: string | undefined; active: boolean; strong: boolean } {
  const session = store.storage.getSession(claim.session_id);
  const agent = normalizeAgent(
    store.storage.getParticipantAgent(claim.task_id, claim.session_id) ?? session?.ide,
  );
  const strong = isStrongClaimAge(
    classifyClaimAge(claim, {
      claim_stale_minutes: store.settings.claimStaleMinutes,
    }),
  );
  const active = Boolean(session && session.ended_at === null && agent !== undefined && strong);
  return { agent, active, strong };
}

function normalizeAgent(agent: string | undefined): string | undefined {
  if (!agent) return undefined;
  const normalized = agent === 'claude-code' ? 'claude' : agent;
  if (normalized === 'unknown' || normalized === 'unbound' || normalized === 'agent')
    return undefined;
  return normalized;
}
