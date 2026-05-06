import { resolve } from 'node:path';
import { type TaskClaimRow, type TaskRow, isProtectedBranch } from '@colony/storage';
import { classifyClaimAge, isStrongClaimAge } from './claim-age.js';
import { normalizeClaimFilePath } from './live-file-contention.js';
import type { MemoryStore } from './memory-store.js';
import {
  type WorktreeContentionReport,
  readWorktreeContentionReport,
} from './worktree-contention.js';

export type GuardedClaimStatus =
  | 'claimed'
  | 'refreshed_same_session'
  | 'refreshed_same_lane'
  | 'superseded_inactive_owner'
  | 'takeover_recommended'
  | 'blocked_active_owner'
  | 'invalid_path'
  | 'task_not_found'
  | 'protected_branch_rejected';

export interface GuardedClaimResult {
  status: GuardedClaimStatus;
  task_id: number;
  file_path: string;
  claim_task_id?: number;
  owner_session_id?: string;
  owner_agent?: string | undefined;
  owner_active?: boolean;
  owner_dirty?: boolean;
  recommendation?: string;
  /**
   * Set when the task's branch is one of the repo-wide protected base
   * branches (`main`, `master`, `dev`, etc.). Editing on a protected
   * branch violates the worktree-discipline contract: every task should
   * run on a dedicated `agent/*` branch in a managed worktree. Callers
   * decide how to surface this — a hard refusal would regress sessions
   * that lawfully resume work on existing `main`-bound tasks, so this
   * is a soft warning by default and the claim is still recorded.
   */
  protected_branch?: {
    branch: string;
    warning: string;
  };
}

export function guardedClaimFile(
  store: MemoryStore,
  args: {
    task_id: number;
    file_path: string;
    session_id: string;
    agent?: string;
    worktreeContention?: WorktreeContentionReport | null;
    dryRun?: boolean;
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
  const protectedBranchWarning: GuardedClaimResult['protected_branch'] = isProtectedBranch(
    task.branch,
  )
    ? {
        branch: task.branch,
        warning: `Task is on protected base branch '${task.branch}'. Per worktree-discipline contract, claims should land on an agent/* branch inside .omc/agent-worktrees/. Start a worktree with 'gx branch start "<task>" "<agent>"' before claiming.`,
      }
    : undefined;
  // Hard reject claims on protected base branches when the setting is on
  // and the caller hasn't asked for the soft-warning escape hatch via
  // env. This is the lever that stops health's "claims on protected
  // branches" from drifting back to non-zero after a sweep.
  if (
    protectedBranchWarning &&
    store.settings.rejectProtectedBranchClaims === true &&
    process.env.COLONY_ALLOW_PROTECTED_CLAIM !== '1' &&
    args.dryRun !== true
  ) {
    return {
      status: 'protected_branch_rejected',
      task_id: args.task_id,
      file_path: filePath,
      protected_branch: protectedBranchWarning,
      recommendation: `Move work to an agent/* worktree before claiming. Run 'gx branch start "<task>" "<agent>"' to start a lane, or set COLONY_ALLOW_PROTECTED_CLAIM=1 to bypass once.`,
    };
  }
  const withWarning = <T extends GuardedClaimResult>(result: T): T =>
    protectedBranchWarning ? { ...result, protected_branch: protectedBranchWarning } : result;

  const scopedClaims = findScopedClaims(store, task, filePath);
  if (scopedClaims.length === 0) {
    claimFileUnlessDryRun(store, { ...args, file_path: filePath });
    return withWarning({
      status: 'claimed',
      task_id: args.task_id,
      file_path: filePath,
      claim_task_id: args.task_id,
    });
  }

  const requesterAgent = normalizeAgent(
    args.agent ??
      store.storage.getParticipantAgent(args.task_id, args.session_id) ??
      store.storage.getSession(args.session_id)?.ide,
  );
  const protectedFile = isProtectedFile(store, filePath);
  const claims = scopedClaims.map((entry) => ({
    ...entry,
    owner: claimOwner(store, entry.task, entry.claim, filePath, args.worktreeContention),
  }));

  const blockingActive = claims.find((entry) => {
    if (entry.claim.session_id === args.session_id) return false;
    if (!entry.owner.active) return false;
    return !sameReusableLane({
      protectedFile,
      ownerAgent: entry.owner.agent,
      requesterAgent,
    });
  });
  if (blockingActive) {
    return withWarning({
      status: 'blocked_active_owner',
      task_id: args.task_id,
      file_path: filePath,
      claim_task_id: blockingActive.claim.task_id,
      owner_session_id: blockingActive.claim.session_id,
      owner_agent: blockingActive.owner.agent,
      owner_active: true,
      owner_dirty: blockingActive.owner.dirty,
      recommendation: `request handoff or explicit takeover from active owner ${blockingActive.claim.session_id} before claiming ${filePath}`,
    });
  }

  const dirtyOwner = claims.find(
    (entry) => entry.claim.session_id !== args.session_id && entry.owner.dirty,
  );
  if (dirtyOwner) {
    return withWarning({
      status: 'takeover_recommended',
      task_id: args.task_id,
      file_path: filePath,
      claim_task_id: dirtyOwner.claim.task_id,
      owner_session_id: dirtyOwner.claim.session_id,
      owner_agent: dirtyOwner.owner.agent,
      owner_active: dirtyOwner.owner.active,
      owner_dirty: true,
      recommendation: `dirty worktree still has ${filePath}; require handoff or rescue from ${dirtyOwner.claim.session_id} before claiming`,
    });
  }

  const sameSessionClaim = claims.find((entry) => entry.claim.session_id === args.session_id);
  if (sameSessionClaim) {
    claimFileUnlessDryRun(store, {
      ...args,
      task_id: sameSessionClaim.claim.task_id,
      file_path: sameSessionClaim.claim.file_path,
    });
    return withWarning({
      status: 'refreshed_same_session',
      task_id: args.task_id,
      file_path: filePath,
      claim_task_id: sameSessionClaim.claim.task_id,
      owner_session_id: sameSessionClaim.claim.session_id,
      owner_agent: sameSessionClaim.owner.agent,
      owner_active: sameSessionClaim.owner.active,
      owner_dirty: sameSessionClaim.owner.dirty,
    });
  }

  const sameLaneClaim = claims.find((entry) =>
    sameReusableLane({
      protectedFile,
      ownerAgent: entry.owner.agent,
      requesterAgent,
    }),
  );
  if (sameLaneClaim) {
    claimFileUnlessDryRun(store, {
      ...args,
      task_id: sameLaneClaim.claim.task_id,
      file_path: sameLaneClaim.claim.file_path,
    });
    return withWarning({
      status: 'refreshed_same_lane',
      task_id: args.task_id,
      file_path: filePath,
      claim_task_id: sameLaneClaim.claim.task_id,
      owner_session_id: sameLaneClaim.claim.session_id,
      owner_agent: sameLaneClaim.owner.agent,
      owner_active: sameLaneClaim.owner.active,
      owner_dirty: sameLaneClaim.owner.dirty,
    });
  }

  const takeoverClaim = claims[0];
  if (takeoverClaim) {
    claimFileUnlessDryRun(store, {
      ...args,
      task_id: takeoverClaim.claim.task_id,
      file_path: takeoverClaim.claim.file_path,
    });
    return withWarning({
      status: 'superseded_inactive_owner',
      task_id: args.task_id,
      file_path: filePath,
      claim_task_id: takeoverClaim.claim.task_id,
      owner_session_id: takeoverClaim.claim.session_id,
      owner_agent: takeoverClaim.owner.agent,
      owner_active: false,
      owner_dirty: false,
    });
  }

  claimFileUnlessDryRun(store, { ...args, file_path: filePath });
  return withWarning({
    status: 'claimed',
    task_id: args.task_id,
    file_path: filePath,
    claim_task_id: args.task_id,
  });
}

function claimFileUnlessDryRun(
  store: MemoryStore,
  args: { task_id: number; file_path: string; session_id: string; dryRun?: boolean },
): void {
  if (args.dryRun === true) return;
  store.storage.claimFile({
    task_id: args.task_id,
    file_path: args.file_path,
    session_id: args.session_id,
  });
}

function findScopedClaims(
  store: MemoryStore,
  task: TaskRow,
  filePath: string,
): Array<{ task: TaskRow; claim: TaskClaimRow }> {
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

  const matches: Array<{ task: TaskRow; claim: TaskClaimRow }> = [];
  for (const candidate of tasks) {
    for (const claim of store.storage.listClaims(candidate.id)) {
      if (claim.state !== 'active') continue;
      const normalized = store.storage.normalizeTaskFilePath(candidate.id, claim.file_path);
      if (normalized === filePath) matches.push({ task: candidate, claim });
    }
  }
  return matches.sort(compareScopedClaims);
}

function claimOwner(
  store: MemoryStore,
  task: TaskRow,
  claim: TaskClaimRow,
  filePath: string,
  worktreeContention: WorktreeContentionReport | null | undefined,
): { agent: string | undefined; active: boolean; strong: boolean; dirty: boolean } {
  const session = store.storage.getSession(claim.session_id);
  const agent = normalizeAgent(
    store.storage.getParticipantAgent(claim.task_id, claim.session_id) ?? session?.ide,
  );
  const strong = isStrongClaimAge(
    classifyClaimAge(claim, {
      claim_stale_minutes: store.settings.claimStaleMinutes,
    }),
  );
  const active = Boolean(session && session.ended_at === null && strong);
  const dirty = dirtyWorktreeHasClaimedFile(task, filePath, worktreeContention);
  return { agent, active, strong, dirty };
}

function sameReusableLane(args: {
  protectedFile: boolean;
  ownerAgent: string | undefined;
  requesterAgent: string | undefined;
}): boolean {
  return (
    !args.protectedFile &&
    args.ownerAgent !== undefined &&
    args.requesterAgent !== undefined &&
    args.ownerAgent === args.requesterAgent
  );
}

function dirtyWorktreeHasClaimedFile(
  task: TaskRow,
  filePath: string,
  worktreeContention: WorktreeContentionReport | null | undefined,
): boolean {
  const report = worktreeContention ?? safeReadWorktreeContention(task.repo_root);
  if (!report) return false;
  const normalizedFilePath = normalizeClaimFilePath(filePath);
  return report.worktrees.some(
    (worktree) =>
      worktree.branch === task.branch &&
      worktree.dirty_files.some(
        (dirty) => normalizeClaimFilePath(dirty.path) === normalizedFilePath,
      ),
  );
}

function safeReadWorktreeContention(repoRoot: string): WorktreeContentionReport | null {
  try {
    return readWorktreeContentionReport({ repoRoot });
  } catch {
    return null;
  }
}

function isProtectedFile(store: MemoryStore, filePath: string): boolean {
  const normalizedFilePath = normalizeClaimFilePath(filePath);
  return store.settings.protected_files.some(
    (protectedFile) => normalizeClaimFilePath(protectedFile) === normalizedFilePath,
  );
}

function compareScopedClaims(
  left: { task: TaskRow; claim: TaskClaimRow },
  right: { task: TaskRow; claim: TaskClaimRow },
): number {
  if (left.claim.claimed_at !== right.claim.claimed_at) {
    return right.claim.claimed_at - left.claim.claimed_at;
  }
  if (left.task.id !== right.task.id) return left.task.id - right.task.id;
  return left.claim.session_id.localeCompare(right.claim.session_id);
}

function normalizeAgent(agent: string | undefined): string | undefined {
  if (!agent) return undefined;
  const normalized = agent === 'claude-code' ? 'claude' : agent;
  if (normalized === 'unknown' || normalized === 'unbound' || normalized === 'agent')
    return undefined;
  return normalized;
}
