import { resolve } from 'node:path';
import type {
  ObservationRow,
  PheromoneRow,
  ProposalRow,
  TaskClaimRow,
  TaskRow,
} from '@colony/storage';
import {
  type ClaimAgeClass,
  type ClaimOwnershipStrength,
  classifyClaimAge,
  isStrongClaimAge,
} from './claim-age.js';
import { type HivemindSnapshot, readHivemind } from './hivemind.js';
import type { MemoryStore } from './memory-store.js';
import { PheromoneSystem } from './pheromone.js';
import { type SubtaskInfo, listPlans } from './plan.js';
import { ProposalSystem } from './proposal-system.js';
import { type HandoffMetadata, parseMessage } from './task-thread.js';
import {
  type WorktreeContentionReport,
  readWorktreeContentionReport,
} from './worktree-contention.js';

const HOT_FILE_NOISE_FLOOR = 0.1;
const STALE_HOT_FILE_MIN_ORIGINAL_STRENGTH = 1;
const DEFAULT_HANDOFF_TTL_MS = 2 * 60 * 60 * 1000;

export interface CoordinationSweepOptions {
  repo_root?: string;
  repo_roots?: string[];
  now?: number;
  stale_claim_minutes?: number;
  hot_file_noise_floor?: number;
  stale_hot_file_min_original_strength?: number;
  release_stale_blockers?: boolean;
  release_safe_stale_claims?: boolean;
  release_same_branch_duplicates?: boolean;
  release_expired_quota_claims?: boolean;
  /**
   * When set, also release every quota-pending claim whose age in minutes is
   * at-or-above this threshold, regardless of whether `expires_at` has been
   * reached. Use this to evacuate handoffs that were posted while no agent
   * was around to accept and that would otherwise sit in the metric until
   * their TTL expires (often hours).
   */
  release_aged_quota_pending_minutes?: number;
  /**
   * When set, archive queen plans whose every sub-task has its latest
   * `plan-subtask-claim` observation in `metadata.status='completed'`.
   * The MCP plan-tool sweep only fires for plans with `auto_archive=true`
   * in plan-config, so opt-out plans linger as "completed but unarchived"
   * on the queen_plan_readiness health signal forever. This sweep
   * resolves them via `findCompletedQueenPlans` + `archiveQueenPlan`
   * without requiring per-plan opt-in. Pure storage operation; emits no
   * observation (callers can re-read the plan-config if they want to
   * surface the archive event in timelines).
   */
  archive_completed_plans?: boolean;
  hivemind?: HivemindSnapshot;
  worktree_contention?: WorktreeContentionReport;
}

export interface CoordinationSweepResult {
  generated_at: number;
  repo_root: string | null;
  thresholds: {
    stale_claim_minutes: number;
    hot_file_noise_floor: number;
    stale_hot_file_min_original_strength: number;
    proposal_noise_floor: number;
  };
  summary: {
    active_claim_count: number;
    /** Backward-compatible alias for active_claim_count. */
    fresh_claim_count: number;
    stale_claim_count: number;
    expired_weak_claim_count: number;
    expired_handoff_count: number;
    expired_message_count: number;
    decayed_proposal_count: number;
    stale_hot_file_count: number;
    blocked_downstream_task_count: number;
    stale_downstream_blocker_count: number;
    same_branch_duplicate_claim_count: number;
    released_stale_blocker_claim_count: number;
    requeued_stale_blocker_count: number;
    released_same_branch_duplicate_claim_count: number;
    released_aged_quota_pending_claim_count: number;
    released_expired_quota_pending_claim_count: number;
    released_stale_claim_count: number;
    downgraded_stale_claim_count: number;
    archived_completed_plan_count: number;
    /** Normalized safe-cleanup counters for CLI/health reporting. */
    stale_claims: number;
    expired_or_weak_claims: number;
    quota_pending_claims: number;
    released_quota_pending_claims: number;
    released_claims: number;
    downgraded_claims: number;
    skipped_dirty_claims: number;
    skipped_active_claims: number;
    skipped_downstream_blocking_claims: number;
    /**
     * Legacy field: counts every skipped safe-cleanup claim, including
     * dirty, active-session, and downstream-blocking skips.
     */
    skipped_dirty_claim_count: number;
  };
  active_claims: FreshClaimSignal[];
  /** Backward-compatible alias for active_claims. */
  fresh_claims: FreshClaimSignal[];
  stale_claims: StaleClaimSignal[];
  expired_weak_claims: ExpiredWeakClaimSignal[];
  top_stale_branches: StaleClaimBranchSummary[];
  recommended_action: string;
  /** Backward-compatible alias for recommended_action. */
  suggested_cleanup_action: string;
  expired_handoffs: ExpiredHandoffSignal[];
  expired_messages: ExpiredMessageSignal[];
  decayed_proposals: DecayedProposalSignal[];
  stale_hot_files: StaleHotFileSignal[];
  blocked_downstream_tasks: BlockedDownstreamTaskSignal[];
  stale_downstream_blockers: StaleDownstreamBlockerSignal[];
  same_branch_duplicate_claims: SameBranchDuplicateClaimSignal[];
  released_stale_downstream_blockers: ReleasedStaleDownstreamBlocker[];
  released_same_branch_duplicate_claims: ReleasedSameBranchDuplicateClaim[];
  released_expired_quota_pending_claims: ReleasedExpiredQuotaPendingClaim[];
  released_stale_claims: ReleasedStaleClaim[];
  downgraded_stale_claims: DowngradedStaleClaim[];
  skipped_dirty_claims: SkippedDirtyClaim[];
  archived_completed_plans: ArchivedCompletedPlan[];
  safe_cleanup: CoordinationSweepSafeCleanupReport;
  recommended_actions: string[];
}

export interface ArchivedCompletedPlan {
  plan_slug: string;
  parent_task_id: number;
  repo_root: string;
  subtask_count: number;
  archived_rows: number;
}

export interface CoordinationSweepSafeCleanupReport {
  stale_claims: number;
  expired_or_weak_claims: number;
  quota_pending_claims: number;
  released_quota_pending_claims: number;
  released_claims: number;
  downgraded_claims: number;
  skipped_dirty_claims: number;
  skipped_active_claims: number;
  skipped_downstream_blocking_claims: number;
  recommended_actions: string[];
}

export type ClaimCleanupAction = 'keep_fresh' | 'review_stale_claim' | 'expire_weak_claim';
export type ClaimWeakReason = 'expired_age' | 'pheromone_below_noise_floor';

export interface ClaimSignal {
  task_id: number;
  task_title: string;
  repo_root: string;
  branch: string;
  file_path: string;
  session_id: string;
  claimed_at: number;
  age_minutes: number;
  age_class: ClaimAgeClass;
  ownership_strength: ClaimOwnershipStrength;
  original_strength: number;
  current_strength: number;
  latest_deposited_at: number | null;
  state: TaskClaimRow['state'];
  expires_at: number | null;
  handoff_observation_id: number | null;
  cleanup_action: ClaimCleanupAction;
  weak_reason: ClaimWeakReason | null;
  cleanup_summary: string;
}

export interface FreshClaimSignal extends ClaimSignal {
  cleanup_action: 'keep_fresh';
}

export interface StaleClaimSignal extends ClaimSignal {
  cleanup_action: 'review_stale_claim' | 'expire_weak_claim';
}

export interface ExpiredWeakClaimSignal extends ClaimSignal {
  cleanup_action: 'expire_weak_claim';
}

export interface StaleClaimBranchSummary {
  repo_root: string;
  branch: string;
  stale_claim_count: number;
  expired_weak_claim_count: number;
  oldest_claim_age_minutes: number;
  suggested_cleanup_action: string;
}

export interface ExpiredHandoffSignal {
  observation_id: number;
  task_id: number;
  task_title: string;
  repo_root: string;
  branch: string;
  from_session_id: string;
  from_agent: string;
  to_agent: string;
  to_session_id: string | null;
  status: string;
  expires_at: number;
  expired_minutes: number;
  summary: string;
}

export interface ExpiredMessageSignal {
  observation_id: number;
  task_id: number;
  task_title: string;
  repo_root: string;
  branch: string;
  from_session_id: string;
  from_agent: string;
  to_agent: string;
  to_session_id: string | null;
  urgency: string;
  status: string;
  expires_at: number;
  expired_minutes: number;
  preview: string;
}

export interface DecayedProposalSignal {
  proposal_id: number;
  repo_root: string;
  branch: string;
  summary: string;
  proposed_by: string;
  proposed_at: number;
  age_minutes: number;
  strength: number;
  noise_floor: number;
  reinforcement_count: number;
  touches_files: string[];
}

export interface StaleHotFileSignal {
  task_id: number;
  task_title: string;
  repo_root: string;
  branch: string;
  file_path: string;
  original_strength: number;
  current_strength: number;
  latest_deposited_at: number;
  age_minutes: number;
  sessions: string[];
}

export interface BlockedDownstreamTaskSignal {
  plan_slug: string;
  plan_title: string;
  repo_root: string;
  task_id: number;
  subtask_index: number;
  subtask_title: string;
  status: string;
  blocked_by_count: number;
  blocked_by: Array<{
    subtask_index: number;
    title: string;
    status: string;
    task_id: number;
  }>;
}

export interface StaleDownstreamBlockerSignal {
  plan_slug: string;
  plan_title: string;
  repo_root: string;
  task_id: number;
  subtask_index: number;
  subtask_title: string;
  file_path: string;
  owner_session_id: string;
  owner_agent: string | null;
  claimed_at: number;
  age_minutes: number;
  age_class: ClaimAgeClass;
  unlock_candidate: {
    task_id: number;
    subtask_index: number;
    title: string;
    file_scope: string[];
  };
  blocked_downstream: Array<{
    task_id: number;
    subtask_index: number;
    title: string;
    status: string;
  }>;
  cleanup_action: 'release_and_requeue_stale_blocker';
  cleanup_summary: string;
}

export interface SameBranchDuplicateClaimSignal
  extends Omit<ClaimSignal, 'cleanup_action' | 'weak_reason' | 'cleanup_summary'> {
  duplicate_session_ids: string[];
  cleanup_action: 'release_same_branch_duplicate';
  cleanup_summary: string;
}

export interface ReleasedStaleDownstreamBlocker {
  plan_slug: string;
  task_id: number;
  subtask_index: number;
  released_claim_count: number;
  audit_observation_id: number;
  requeue_observation_id: number;
}

export interface ReleasedSameBranchDuplicateClaim {
  task_id: number;
  branch: string;
  file_path: string;
  session_id: string;
  duplicate_session_ids: string[];
  cleanup_action: 'release_same_branch_duplicate';
  reason: 'same_branch_duplicate';
  audit_observation_id: number;
}

export interface ReleasedStaleClaim {
  task_id: number;
  file_path: string;
  session_id: string;
  cleanup_action: 'release_stale_claim';
  reason: 'expired_weak_claim';
  audit_observation_id: number;
}

export interface ReleasedExpiredQuotaPendingClaim {
  task_id: number;
  branch: string;
  file_path: string;
  session_id: string;
  handoff_observation_id: number;
  expires_at: number;
  age_minutes: number;
  cleanup_action: 'release_expired_quota_pending' | 'release_aged_quota_pending';
  reason: 'quota_pending_expired' | 'quota_pending_aged';
  audit_observation_id: number;
}

export interface DowngradedStaleClaim {
  task_id: number;
  file_path: string;
  session_id: string;
  cleanup_action: 'downgrade_stale_claim';
  reason: 'inactive_non_dirty_stale_claim';
  audit_observation_id: number;
}

export interface SkippedDirtyClaim {
  task_id: number;
  file_path: string;
  session_id: string;
  branch: string;
  cleanup_action: 'skip_dirty_claim';
  reason: 'dirty_worktree' | 'active_session' | 'stale_downstream_blocker';
  recommended_action: string;
}

export function buildCoordinationSweep(
  store: MemoryStore,
  opts: CoordinationSweepOptions = {},
): CoordinationSweepResult {
  const now = opts.now ?? Date.now();
  const proposalSystem = new ProposalSystem(store, { now: () => now });
  const thresholds = {
    stale_claim_minutes: opts.stale_claim_minutes ?? store.settings.claimStaleMinutes,
    hot_file_noise_floor: opts.hot_file_noise_floor ?? HOT_FILE_NOISE_FLOOR,
    stale_hot_file_min_original_strength:
      opts.stale_hot_file_min_original_strength ?? STALE_HOT_FILE_MIN_ORIGINAL_STRENGTH,
    proposal_noise_floor: proposalSystem.noiseFloor,
  };
  const repoRoots = normalizedRepoRoots(opts);
  const tasks = store.storage
    .listTasks(2_000)
    .filter((task) => repoRoots === null || repoRoots.has(resolve(task.repo_root)));

  const claimBuckets = collectClaimBuckets(store, tasks, now, thresholds);
  const expired_handoffs = collectExpiredHandoffs(store, tasks, now);
  const expired_messages = collectExpiredMessages(store, tasks, now);
  const decayed_proposals = collectDecayedProposals(store, proposalSystem, repoRoots, now);
  const stale_hot_files = collectStaleHotFiles(store, tasks, now, thresholds);
  const blocked_downstream_tasks = collectBlockedDownstreamTasks(store, repoRoots);
  const stale_downstream_blockers = collectStaleDownstreamBlockers(
    store,
    repoRoots,
    now,
    thresholds,
  );
  const sameBranchDuplicateClaims = collectSameBranchDuplicateClaims(
    [...claimBuckets.active_claims, ...claimBuckets.stale_claims],
    { group_across_repo_roots: repoRoots !== null },
  );
  const released_same_branch_duplicate_claims =
    opts.release_same_branch_duplicates === true
      ? releaseSameBranchDuplicateClaims(store, sameBranchDuplicateClaims, now)
      : [];
  const duplicateCleanupKeys = new Set(
    released_same_branch_duplicate_claims.map((claim) => staleClaimKey(claim)),
  );
  const activeClaims = filterClaimSignals(claimBuckets.active_claims, duplicateCleanupKeys);
  const staleClaims = filterClaimSignals(claimBuckets.stale_claims, duplicateCleanupKeys);
  const expiredWeakClaims = filterClaimSignals(
    claimBuckets.expired_weak_claims,
    duplicateCleanupKeys,
  ) as ExpiredWeakClaimSignal[];
  const remainingSameBranchDuplicateClaims =
    opts.release_same_branch_duplicates === true ? [] : sameBranchDuplicateClaims;
  const staleClaimCleanupContext = staleClaimCleanupContextFor(store, opts, now);
  const staleClaimCleanup =
    opts.release_safe_stale_claims === true
      ? releaseSafeStaleClaims(store, staleClaims, stale_downstream_blockers, {
          now,
          ...staleClaimCleanupContext,
        })
      : emptyStaleClaimCleanup(staleClaims, stale_downstream_blockers, {
          ...staleClaimCleanupContext,
        });
  const released_stale_downstream_blockers =
    opts.release_stale_blockers === true
      ? releaseStaleDownstreamBlockers(store, stale_downstream_blockers, now)
      : [];
  const expiredQuotaPendingClaims = collectExpiredQuotaPendingClaims(
    [...claimBuckets.stale_claims, ...claimBuckets.expired_weak_claims],
    now,
  );
  const released_expired_quota_pending_claims =
    opts.release_expired_quota_claims === true
      ? releaseExpiredQuotaPendingClaims(store, expiredQuotaPendingClaims, now)
      : [];
  // Aged-but-not-yet-expired quota-pending claims live in the active bucket
  // (state='handoff_pending', expires_at > now). The expired sweep above
  // never sees them, so handoffs sit in the signal-evaporation metric until
  // their TTL — often hours — runs out. Operators can opt into evacuating
  // anything older than the supplied threshold.
  const agedQuotaPendingClaims =
    typeof opts.release_aged_quota_pending_minutes === 'number'
      ? collectAgedQuotaPendingClaims(
          [
            ...claimBuckets.active_claims,
            ...claimBuckets.stale_claims,
            ...claimBuckets.expired_weak_claims,
          ],
          opts.release_aged_quota_pending_minutes,
          // Skip duplicates already handled by the expired sweep above.
          released_expired_quota_pending_claims,
        )
      : [];
  const released_aged_quota_pending_claims =
    typeof opts.release_aged_quota_pending_minutes === 'number'
      ? releaseAgedQuotaPendingClaims(store, agedQuotaPendingClaims, now)
      : [];
  const releasedQuotaPendingClaimCount =
    released_expired_quota_pending_claims.length + released_aged_quota_pending_claims.length;
  const archived_completed_plans =
    opts.archive_completed_plans === true ? archiveCompletedPlans(store, opts) : [];
  const remainingStaleClaims = filterRemainingStaleClaims(staleClaims, staleClaimCleanup);
  const remainingExpiredWeakClaims = filterRemainingStaleClaims(
    expiredWeakClaims,
    staleClaimCleanup,
  ) as ExpiredWeakClaimSignal[];
  const recommended_action = suggestClaimCleanup({
    fresh_claims: activeClaims,
    stale_claims: remainingStaleClaims,
    expired_weak_claims: remainingExpiredWeakClaims,
    stale_downstream_blocker_count: stale_downstream_blockers.length,
    same_branch_duplicate_claim_count: remainingSameBranchDuplicateClaims.length,
    released_stale_blocker_count: released_stale_downstream_blockers.length,
    released_same_branch_duplicate_claim_count: released_same_branch_duplicate_claims.length,
    released_stale_claim_count: staleClaimCleanup.released_stale_claims.length,
    downgraded_stale_claim_count: staleClaimCleanup.downgraded_stale_claims.length,
    skipped_dirty_claim_count: staleClaimCleanup.skipped_dirty_claims.length,
  });
  const recommended_actions = recommendedActions({
    recommended_action,
    stale_downstream_blockers,
    same_branch_duplicate_claims: remainingSameBranchDuplicateClaims,
    skipped_dirty_claims: staleClaimCleanup.skipped_dirty_claims,
    released_same_branch_duplicate_claims,
    released_stale_claims: staleClaimCleanup.released_stale_claims,
    downgraded_stale_claims: staleClaimCleanup.downgraded_stale_claims,
  });
  const safe_cleanup = safeCleanupReport({
    stale_claims: staleClaims,
    expired_weak_claims: expiredWeakClaims,
    cleanup: staleClaimCleanup,
    recommended_actions,
    released_quota_pending_claim_count: releasedQuotaPendingClaimCount,
  });

  return {
    generated_at: now,
    repo_root: opts.repo_root ?? null,
    thresholds,
    summary: {
      active_claim_count: activeClaims.length,
      fresh_claim_count: activeClaims.length,
      stale_claim_count: remainingStaleClaims.length,
      expired_weak_claim_count: remainingExpiredWeakClaims.length,
      expired_handoff_count: expired_handoffs.length,
      expired_message_count: expired_messages.length,
      decayed_proposal_count: decayed_proposals.length,
      stale_hot_file_count: stale_hot_files.length,
      blocked_downstream_task_count: blocked_downstream_tasks.length,
      stale_downstream_blocker_count: stale_downstream_blockers.length,
      same_branch_duplicate_claim_count: remainingSameBranchDuplicateClaims.length,
      released_stale_blocker_claim_count: released_stale_downstream_blockers.reduce(
        (sum, row) => sum + row.released_claim_count,
        0,
      ),
      requeued_stale_blocker_count: released_stale_downstream_blockers.length,
      released_same_branch_duplicate_claim_count: released_same_branch_duplicate_claims.length,
      released_expired_quota_pending_claim_count: released_expired_quota_pending_claims.length,
      released_aged_quota_pending_claim_count: released_aged_quota_pending_claims.length,
      released_stale_claim_count: staleClaimCleanup.released_stale_claims.length,
      downgraded_stale_claim_count: staleClaimCleanup.downgraded_stale_claims.length,
      archived_completed_plan_count: archived_completed_plans.length,
      stale_claims: safe_cleanup.stale_claims,
      expired_or_weak_claims: safe_cleanup.expired_or_weak_claims,
      quota_pending_claims: safe_cleanup.quota_pending_claims,
      released_quota_pending_claims: safe_cleanup.released_quota_pending_claims,
      released_claims: safe_cleanup.released_claims,
      downgraded_claims: safe_cleanup.downgraded_claims,
      skipped_dirty_claims: safe_cleanup.skipped_dirty_claims,
      skipped_active_claims: safe_cleanup.skipped_active_claims,
      skipped_downstream_blocking_claims: safe_cleanup.skipped_downstream_blocking_claims,
      skipped_dirty_claim_count: staleClaimCleanup.skipped_dirty_claims.length,
    },
    active_claims: activeClaims,
    fresh_claims: activeClaims,
    stale_claims: remainingStaleClaims,
    expired_weak_claims: remainingExpiredWeakClaims,
    top_stale_branches: topStaleBranches(remainingStaleClaims),
    recommended_action,
    suggested_cleanup_action: recommended_action,
    recommended_actions,
    expired_handoffs,
    expired_messages,
    decayed_proposals,
    stale_hot_files,
    blocked_downstream_tasks,
    stale_downstream_blockers,
    same_branch_duplicate_claims: remainingSameBranchDuplicateClaims,
    released_stale_downstream_blockers,
    released_same_branch_duplicate_claims,
    released_expired_quota_pending_claims: [
      ...released_expired_quota_pending_claims,
      ...released_aged_quota_pending_claims,
    ],
    released_stale_claims: staleClaimCleanup.released_stale_claims,
    downgraded_stale_claims: staleClaimCleanup.downgraded_stale_claims,
    skipped_dirty_claims: staleClaimCleanup.skipped_dirty_claims,
    archived_completed_plans,
    safe_cleanup,
  };
}

function archiveCompletedPlans(
  store: MemoryStore,
  opts: CoordinationSweepOptions,
): ArchivedCompletedPlan[] {
  const candidates = store.storage.findCompletedQueenPlans(opts.repo_root);
  const archived: ArchivedCompletedPlan[] = [];
  for (const candidate of candidates) {
    const result = store.storage.archiveQueenPlan({
      repo_root: candidate.repo_root,
      plan_slug: candidate.plan_slug,
    });
    if (result.archived_rows === 0) continue;
    archived.push({
      plan_slug: candidate.plan_slug,
      parent_task_id: candidate.parent_task_id,
      repo_root: candidate.repo_root,
      subtask_count: candidate.subtask_count,
      archived_rows: result.archived_rows,
    });
  }
  return archived;
}

function normalizedRepoRoots(opts: CoordinationSweepOptions): Set<string> | null {
  const roots = [opts.repo_root, ...(opts.repo_roots ?? [])].filter(
    (root): root is string => typeof root === 'string' && root.length > 0,
  );
  if (roots.length === 0) return null;
  return new Set(roots.map((root) => resolve(root)));
}

function collectClaimBuckets(
  store: MemoryStore,
  tasks: TaskRow[],
  now: number,
  thresholds: CoordinationSweepResult['thresholds'],
): {
  active_claims: FreshClaimSignal[];
  fresh_claims: FreshClaimSignal[];
  stale_claims: StaleClaimSignal[];
  expired_weak_claims: ExpiredWeakClaimSignal[];
  top_stale_branches: StaleClaimBranchSummary[];
} {
  const active_claims: FreshClaimSignal[] = [];
  const stale_claims: StaleClaimSignal[] = [];
  const expired_weak_claims: ExpiredWeakClaimSignal[] = [];
  for (const task of tasks) {
    for (const claim of store.storage.listClaims(task.id)) {
      const strength = claimPheromoneStrength(
        store,
        task.id,
        claim.file_path,
        claim.session_id,
        now,
      );
      const ageMinutes = elapsedMinutes(now, claim.claimed_at);
      const classification = classifyClaimAge(claim, {
        now,
        claim_stale_minutes: thresholds.stale_claim_minutes,
      });
      if (classification.ownership_strength === 'strong') {
        active_claims.push({
          task_id: task.id,
          task_title: task.title,
          repo_root: task.repo_root,
          branch: task.branch,
          file_path: claim.file_path,
          session_id: claim.session_id,
          claimed_at: claim.claimed_at,
          age_minutes: ageMinutes,
          age_class: classification.age_class,
          ownership_strength: classification.ownership_strength,
          ...strength,
          state: claim.state,
          expires_at: claim.expires_at,
          handoff_observation_id: claim.handoff_observation_id,
          cleanup_action: 'keep_fresh',
          weak_reason: null,
          cleanup_summary: 'keep active; claim is inside the fresh window',
        });
        continue;
      }

      const weakReason = claimWeakReason(classification.age_class, strength, thresholds);
      const isExpiredWeak = weakReason !== null;
      const signal: StaleClaimSignal = {
        task_id: task.id,
        task_title: task.title,
        repo_root: task.repo_root,
        branch: task.branch,
        file_path: claim.file_path,
        session_id: claim.session_id,
        claimed_at: claim.claimed_at,
        age_minutes: ageMinutes,
        age_class: classification.age_class,
        ownership_strength: classification.ownership_strength,
        ...strength,
        state: claim.state,
        expires_at: claim.expires_at,
        handoff_observation_id: claim.handoff_observation_id,
        cleanup_action: isExpiredWeak ? 'expire_weak_claim' : 'review_stale_claim',
        weak_reason: weakReason,
        cleanup_summary: claimCleanupSummary(weakReason),
      };
      stale_claims.push(signal);
      if (isExpiredWeak) expired_weak_claims.push(signal as ExpiredWeakClaimSignal);
    }
  }

  active_claims.sort(
    (a, b) => b.age_minutes - a.age_minutes || a.file_path.localeCompare(b.file_path),
  );
  stale_claims.sort(
    (a, b) => b.age_minutes - a.age_minutes || a.file_path.localeCompare(b.file_path),
  );
  expired_weak_claims.sort(
    (a, b) => b.age_minutes - a.age_minutes || a.file_path.localeCompare(b.file_path),
  );

  return {
    active_claims,
    fresh_claims: active_claims,
    stale_claims,
    expired_weak_claims,
    top_stale_branches: topStaleBranches(stale_claims),
  };
}

function claimPheromoneStrength(
  store: MemoryStore,
  taskId: number,
  filePath: string,
  sessionId: string,
  now: number,
): Pick<ClaimSignal, 'original_strength' | 'current_strength' | 'latest_deposited_at'> {
  const row = store.storage.getPheromone(taskId, filePath, sessionId);
  if (!row) {
    return { original_strength: 0, current_strength: 0, latest_deposited_at: null };
  }
  return {
    original_strength: roundStrength(row.strength),
    current_strength: roundStrength(PheromoneSystem.decay(row.strength, row.deposited_at, now)),
    latest_deposited_at: row.deposited_at,
  };
}

function claimWeakReason(
  ageClass: ClaimAgeClass,
  strength: Pick<ClaimSignal, 'current_strength' | 'latest_deposited_at'>,
  thresholds: CoordinationSweepResult['thresholds'],
): ClaimWeakReason | null {
  if (ageClass === 'expired/weak') return 'expired_age';
  if (
    strength.latest_deposited_at !== null &&
    strength.current_strength < thresholds.hot_file_noise_floor
  ) {
    return 'pheromone_below_noise_floor';
  }
  return null;
}

function claimCleanupSummary(reason: ClaimWeakReason | null): string {
  if (reason === 'expired_age') {
    return 'would release expired/weak advisory claim; audit observations stay intact';
  }
  if (reason === 'pheromone_below_noise_floor') {
    return 'would release pheromone-weak advisory claim; audit observations stay intact';
  }
  return 'review owner activity, then release or hand off if inactive';
}

function topStaleBranches(staleClaims: StaleClaimSignal[]): StaleClaimBranchSummary[] {
  const byBranch = new Map<string, StaleClaimBranchSummary>();
  for (const claim of staleClaims) {
    const key = `${claim.repo_root}\u0000${claim.branch}`;
    const summary =
      byBranch.get(key) ??
      ({
        repo_root: claim.repo_root,
        branch: claim.branch,
        stale_claim_count: 0,
        expired_weak_claim_count: 0,
        oldest_claim_age_minutes: 0,
        suggested_cleanup_action: '',
      } satisfies StaleClaimBranchSummary);
    summary.stale_claim_count += 1;
    if (claim.cleanup_action === 'expire_weak_claim') summary.expired_weak_claim_count += 1;
    summary.oldest_claim_age_minutes = Math.max(
      summary.oldest_claim_age_minutes,
      claim.age_minutes,
    );
    summary.suggested_cleanup_action =
      summary.expired_weak_claim_count > 0
        ? `release ${summary.expired_weak_claim_count} expired/weak advisory claim(s); keep audit observations`
        : `review ${summary.stale_claim_count} stale advisory claim(s)`;
    byBranch.set(key, summary);
  }
  return [...byBranch.values()]
    .sort(
      (a, b) =>
        b.stale_claim_count - a.stale_claim_count ||
        b.expired_weak_claim_count - a.expired_weak_claim_count ||
        b.oldest_claim_age_minutes - a.oldest_claim_age_minutes ||
        a.branch.localeCompare(b.branch),
    )
    .slice(0, 10);
}

function collectSameBranchDuplicateClaims(
  claims: ClaimSignal[],
  opts: { group_across_repo_roots: boolean },
): SameBranchDuplicateClaimSignal[] {
  const byBranchFile = new Map<string, ClaimSignal[]>();
  for (const claim of claims) {
    const key = opts.group_across_repo_roots
      ? `${claim.branch}\u0000${claim.file_path}`
      : `${claim.repo_root}\u0000${claim.branch}\u0000${claim.file_path}`;
    const bucket = byBranchFile.get(key) ?? [];
    bucket.push(claim);
    byBranchFile.set(key, bucket);
  }

  const out: SameBranchDuplicateClaimSignal[] = [];
  for (const bucket of byBranchFile.values()) {
    const sessionIds = [...new Set(bucket.map((claim) => claim.session_id))].sort();
    if (sessionIds.length <= 1) continue;
    for (const claim of bucket) {
      out.push({
        task_id: claim.task_id,
        task_title: claim.task_title,
        repo_root: claim.repo_root,
        branch: claim.branch,
        file_path: claim.file_path,
        session_id: claim.session_id,
        claimed_at: claim.claimed_at,
        age_minutes: claim.age_minutes,
        age_class: claim.age_class,
        ownership_strength: claim.ownership_strength,
        original_strength: claim.original_strength,
        current_strength: claim.current_strength,
        latest_deposited_at: claim.latest_deposited_at,
        state: claim.state,
        expires_at: claim.expires_at,
        handoff_observation_id: claim.handoff_observation_id,
        duplicate_session_ids: sessionIds.filter((sessionId) => sessionId !== claim.session_id),
        cleanup_action: 'release_same_branch_duplicate',
        cleanup_summary:
          'would release same-branch duplicate advisory claim; audit observations stay intact',
      });
    }
  }
  return out.sort(
    (a, b) =>
      a.branch.localeCompare(b.branch) ||
      a.file_path.localeCompare(b.file_path) ||
      a.session_id.localeCompare(b.session_id) ||
      a.repo_root.localeCompare(b.repo_root),
  );
}

function suggestClaimCleanup(args: {
  fresh_claims: FreshClaimSignal[];
  stale_claims: StaleClaimSignal[];
  expired_weak_claims: ExpiredWeakClaimSignal[];
  stale_downstream_blocker_count: number;
  same_branch_duplicate_claim_count: number;
  released_stale_blocker_count: number;
  released_same_branch_duplicate_claim_count: number;
  released_stale_claim_count: number;
  downgraded_stale_claim_count: number;
  skipped_dirty_claim_count: number;
}): string {
  if (args.released_same_branch_duplicate_claim_count > 0) {
    return `applied: released ${args.released_same_branch_duplicate_claim_count} same-branch duplicate claim(s) to audit-only; audit observations stay intact`;
  }
  if (args.released_stale_claim_count > 0 || args.downgraded_stale_claim_count > 0) {
    return `applied: released ${args.released_stale_claim_count} expired/weak stale claim(s), downgraded ${args.downgraded_stale_claim_count} inactive stale claim(s) to audit-only; audit observations stay intact`;
  }
  if (args.released_stale_blocker_count > 0) {
    return `applied: released/requeued ${args.released_stale_blocker_count} stale downstream blocker(s); audit observations stay intact`;
  }
  if (args.same_branch_duplicate_claim_count > 0) {
    return `dry-run: release ${args.same_branch_duplicate_claim_count} same-branch duplicate claim(s) with --release-same-branch-duplicates; audit observations stay intact`;
  }
  if (args.stale_downstream_blocker_count > 0) {
    return `dry-run: release/requeue ${args.stale_downstream_blocker_count} stale downstream blocker(s) with --release-stale-blockers; audit observations stay intact`;
  }
  if (args.expired_weak_claims.length > 0) {
    return `dry-run: release ${args.expired_weak_claims.length} expired/weak advisory claim(s) after owner/rescue review; audit observations stay intact`;
  }
  if (args.stale_claims.length > 0) {
    return `dry-run: review ${args.stale_claims.length} stale advisory claim(s) for owner activity before release or handoff`;
  }
  if (args.fresh_claims.length > 0) {
    return `dry-run: no cleanup; ${args.fresh_claims.length} fresh claim(s) remain active`;
  }
  return 'dry-run: no cleanup; no live claims found';
}

interface StaleClaimCleanupContext {
  dirtyClaimKeys: Set<string>;
  activeSessionIds: Set<string>;
}

interface StaleClaimCleanupResult {
  released_stale_claims: ReleasedStaleClaim[];
  downgraded_stale_claims: DowngradedStaleClaim[];
  skipped_dirty_claims: SkippedDirtyClaim[];
}

function staleClaimCleanupContextFor(
  _store: MemoryStore,
  opts: CoordinationSweepOptions,
  now: number,
): StaleClaimCleanupContext {
  const repoRoots = [opts.repo_root, ...(opts.repo_roots ?? [])].filter(
    (root): root is string => typeof root === 'string' && root.length > 0,
  );
  const firstRepoRoot = repoRoots[0];
  const worktree =
    opts.worktree_contention ??
    (firstRepoRoot ? readWorktreeContentionReport({ repoRoot: firstRepoRoot, now }) : null);
  const hivemind =
    opts.hivemind ??
    (repoRoots.length > 0
      ? readHivemind({ repoRoots, now, includeStale: false, limit: 100 })
      : readHivemind({ now, includeStale: false, limit: 100 }));
  const activeSessionIds = new Set(
    hivemind.sessions
      .filter((session) => session.activity !== 'dead')
      .map((session) => session.session_key)
      .filter(Boolean),
  );
  const dirtyClaimKeys = new Set<string>();
  if (worktree) {
    for (const managed of worktree.worktrees) {
      for (const dirty of managed.dirty_files) {
        dirtyClaimKeys.add(claimKey(managed.branch, dirty.path));
      }
      if (managed.active_session?.session_key) {
        activeSessionIds.add(managed.active_session.session_key);
      }
    }
  }
  return { dirtyClaimKeys, activeSessionIds };
}

function emptyStaleClaimCleanup(
  staleClaims: StaleClaimSignal[],
  staleDownstreamBlockers: StaleDownstreamBlockerSignal[],
  context: StaleClaimCleanupContext,
): StaleClaimCleanupResult {
  return {
    released_stale_claims: [],
    downgraded_stale_claims: [],
    skipped_dirty_claims: skippedStaleClaims(staleClaims, staleDownstreamBlockers, context),
  };
}

function releaseSafeStaleClaims(
  store: MemoryStore,
  staleClaims: StaleClaimSignal[],
  staleDownstreamBlockers: StaleDownstreamBlockerSignal[],
  context: StaleClaimCleanupContext & { now: number },
): StaleClaimCleanupResult {
  const skipped = skippedStaleClaims(staleClaims, staleDownstreamBlockers, context);
  const skippedKeys = new Set(skipped.map((claim) => staleClaimKey(claim)));
  const released_stale_claims: ReleasedStaleClaim[] = [];
  const downgraded_stale_claims: DowngradedStaleClaim[] = [];

  for (const claim of staleClaims) {
    if (skippedKeys.has(staleClaimKey(claim))) continue;
    const result = store.storage.transaction(() => {
      const action =
        claim.cleanup_action === 'expire_weak_claim'
          ? ('release_stale_claim' as const)
          : ('downgrade_stale_claim' as const);
      const auditId = store.addObservation({
        session_id: 'coordination-sweep',
        task_id: claim.task_id,
        kind: 'coordination-sweep',
        content:
          action === 'release_stale_claim'
            ? `Coordination sweep released expired/weak stale claim ${claim.file_path} from ${claim.session_id}; audit history retained.`
            : `Coordination sweep downgraded stale claim ${claim.file_path} from ${claim.session_id} to audit-only history; audit history retained.`,
        metadata: {
          kind: 'coordination-sweep',
          action,
          task_id: claim.task_id,
          file_path: claim.file_path,
          owner_session_id: claim.session_id,
          branch: claim.branch,
          repo_root: claim.repo_root,
          claimed_at: claim.claimed_at,
          age_minutes: claim.age_minutes,
          age_class: claim.age_class,
          weak_reason: claim.weak_reason,
          now: context.now,
        },
      });
      store.storage.releaseClaim({
        task_id: claim.task_id,
        file_path: claim.file_path,
        session_id: claim.session_id,
      });
      store.storage.touchTask(claim.task_id, context.now);
      return auditId;
    });

    if (claim.cleanup_action === 'expire_weak_claim') {
      released_stale_claims.push({
        task_id: claim.task_id,
        file_path: claim.file_path,
        session_id: claim.session_id,
        cleanup_action: 'release_stale_claim',
        reason: 'expired_weak_claim',
        audit_observation_id: result,
      });
    } else {
      downgraded_stale_claims.push({
        task_id: claim.task_id,
        file_path: claim.file_path,
        session_id: claim.session_id,
        cleanup_action: 'downgrade_stale_claim',
        reason: 'inactive_non_dirty_stale_claim',
        audit_observation_id: result,
      });
    }
  }

  return {
    released_stale_claims,
    downgraded_stale_claims,
    skipped_dirty_claims: skipped,
  };
}

function releaseSameBranchDuplicateClaims(
  store: MemoryStore,
  claims: SameBranchDuplicateClaimSignal[],
  now: number,
): ReleasedSameBranchDuplicateClaim[] {
  const released: ReleasedSameBranchDuplicateClaim[] = [];
  for (const claim of claims) {
    const auditId = store.storage.transaction(() => {
      const observationId = store.addObservation({
        session_id: 'coordination-sweep',
        task_id: claim.task_id,
        kind: 'coordination-sweep',
        content: `Coordination sweep released same-branch duplicate claim ${claim.file_path} on ${claim.branch} from ${claim.session_id}; audit history retained.`,
        metadata: {
          kind: 'coordination-sweep',
          action: 'release-same-branch-duplicate',
          task_id: claim.task_id,
          file_path: claim.file_path,
          branch: claim.branch,
          repo_root: claim.repo_root,
          owner_session_id: claim.session_id,
          duplicate_session_ids: claim.duplicate_session_ids,
          claimed_at: claim.claimed_at,
          age_minutes: claim.age_minutes,
          age_class: claim.age_class,
          now,
        },
      });
      store.storage.releaseClaim({
        task_id: claim.task_id,
        file_path: claim.file_path,
        session_id: claim.session_id,
      });
      store.storage.touchTask(claim.task_id, now);
      return observationId;
    });
    released.push({
      task_id: claim.task_id,
      branch: claim.branch,
      file_path: claim.file_path,
      session_id: claim.session_id,
      duplicate_session_ids: claim.duplicate_session_ids,
      cleanup_action: 'release_same_branch_duplicate',
      reason: 'same_branch_duplicate',
      audit_observation_id: auditId,
    });
  }
  return released;
}

function skippedStaleClaims(
  staleClaims: StaleClaimSignal[],
  staleDownstreamBlockers: StaleDownstreamBlockerSignal[],
  context: StaleClaimCleanupContext,
): SkippedDirtyClaim[] {
  const downstreamKeys = new Set(
    staleDownstreamBlockers.map((blocker) =>
      staleClaimKey({
        task_id: blocker.task_id,
        file_path: blocker.file_path,
        session_id: blocker.owner_session_id,
      }),
    ),
  );
  const out: SkippedDirtyClaim[] = [];
  for (const claim of staleClaims) {
    const base = {
      task_id: claim.task_id,
      file_path: claim.file_path,
      session_id: claim.session_id,
      branch: claim.branch,
      cleanup_action: 'skip_dirty_claim' as const,
    };
    if (downstreamKeys.has(staleClaimKey(claim))) {
      out.push({
        ...base,
        reason: 'stale_downstream_blocker',
        recommended_action:
          'run colony coordination sweep --release-stale-blockers after owner/rescue review',
      });
      continue;
    }
    if (context.activeSessionIds.has(claim.session_id)) {
      out.push({
        ...base,
        reason: 'active_session',
        recommended_action: 'active owner still visible; hand off or wait before releasing claim',
      });
      continue;
    }
    if (context.dirtyClaimKeys.has(claimKey(claim.branch, claim.file_path))) {
      out.push({
        ...base,
        reason: 'dirty_worktree',
        recommended_action:
          'dirty worktree still has this file; require handoff or rescue before releasing claim',
      });
    }
  }
  return out.sort(
    (a, b) =>
      a.branch.localeCompare(b.branch) ||
      a.file_path.localeCompare(b.file_path) ||
      a.session_id.localeCompare(b.session_id),
  );
}

function filterClaimSignals<T extends ClaimSignal>(claims: T[], removedKeys: Set<string>): T[] {
  if (removedKeys.size === 0) return claims;
  return claims.filter((claim) => !removedKeys.has(staleClaimKey(claim)));
}

function filterRemainingStaleClaims<T extends StaleClaimSignal>(
  staleClaims: T[],
  cleanup: StaleClaimCleanupResult,
): T[] {
  const removed = new Set([
    ...cleanup.released_stale_claims.map((claim) => staleClaimKey(claim)),
    ...cleanup.downgraded_stale_claims.map((claim) => staleClaimKey(claim)),
  ]);
  return staleClaims.filter((claim) => !removed.has(staleClaimKey(claim)));
}

function recommendedActions(args: {
  recommended_action: string;
  stale_downstream_blockers: StaleDownstreamBlockerSignal[];
  same_branch_duplicate_claims: SameBranchDuplicateClaimSignal[];
  skipped_dirty_claims: SkippedDirtyClaim[];
  released_same_branch_duplicate_claims: ReleasedSameBranchDuplicateClaim[];
  released_stale_claims: ReleasedStaleClaim[];
  downgraded_stale_claims: DowngradedStaleClaim[];
}): string[] {
  const actions = new Set<string>([args.recommended_action]);
  if (args.stale_downstream_blockers.length > 0) {
    actions.add(
      'rescue stale downstream blocker(s): run colony coordination sweep --release-stale-blockers after owner/rescue review',
    );
  }
  if (args.same_branch_duplicate_claims.length > 0) {
    actions.add(
      'release same-branch duplicate claim(s): run colony coordination sweep --release-same-branch-duplicates after confirming branch/file duplicates',
    );
  }
  if (args.skipped_dirty_claims.some((claim) => claim.reason === 'dirty_worktree')) {
    actions.add('dirty stale claim(s) skipped: require handoff or rescue before release');
  }
  if (args.skipped_dirty_claims.some((claim) => claim.reason === 'active_session')) {
    actions.add('active stale claim(s) skipped: owner still visible; wait or hand off first');
  }
  if (args.skipped_dirty_claims.some((claim) => claim.reason === 'stale_downstream_blocker')) {
    actions.add(
      'downstream-blocking stale claim(s) skipped: use --release-stale-blockers only after owner/rescue review',
    );
  }
  if (
    args.released_same_branch_duplicate_claims.length > 0 ||
    args.released_stale_claims.length > 0 ||
    args.downgraded_stale_claims.length > 0
  ) {
    actions.add('audit history retained in coordination-sweep observations');
  }
  return [...actions];
}

function safeCleanupReport(args: {
  stale_claims: StaleClaimSignal[];
  expired_weak_claims: ExpiredWeakClaimSignal[];
  cleanup: StaleClaimCleanupResult;
  recommended_actions: string[];
  released_quota_pending_claim_count: number;
}): CoordinationSweepSafeCleanupReport {
  const skipped = args.cleanup.skipped_dirty_claims;
  return {
    stale_claims: args.stale_claims.length,
    expired_or_weak_claims: args.expired_weak_claims.length,
    quota_pending_claims: args.stale_claims.filter((claim) => claim.state === 'handoff_pending')
      .length,
    released_quota_pending_claims: args.released_quota_pending_claim_count,
    released_claims: args.cleanup.released_stale_claims.length,
    downgraded_claims: args.cleanup.downgraded_stale_claims.length,
    skipped_dirty_claims: skipped.filter((claim) => claim.reason === 'dirty_worktree').length,
    skipped_active_claims: skipped.filter((claim) => claim.reason === 'active_session').length,
    skipped_downstream_blocking_claims: skipped.filter(
      (claim) => claim.reason === 'stale_downstream_blocker',
    ).length,
    recommended_actions: args.recommended_actions,
  };
}

function collectExpiredQuotaPendingClaims(signals: ClaimSignal[], now: number): ClaimSignal[] {
  const seen = new Set<string>();
  const out: ClaimSignal[] = [];
  for (const claim of signals) {
    if (claim.state !== 'handoff_pending') continue;
    if (typeof claim.expires_at !== 'number' || claim.expires_at > now) continue;
    if (claim.handoff_observation_id === null) continue;
    const key = staleClaimKey(claim);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(claim);
  }
  return out;
}

function releaseExpiredQuotaPendingClaims(
  store: MemoryStore,
  claims: ClaimSignal[],
  now: number,
): ReleasedExpiredQuotaPendingClaim[] {
  const released: ReleasedExpiredQuotaPendingClaim[] = [];
  for (const claim of claims) {
    if (claim.handoff_observation_id === null) continue;
    if (typeof claim.expires_at !== 'number') continue;
    const handoff_observation_id = claim.handoff_observation_id;
    const expires_at = claim.expires_at;
    const auditId = store.storage.transaction(() => {
      const observationId = store.addObservation({
        session_id: 'coordination-sweep',
        task_id: claim.task_id,
        kind: 'coordination-sweep',
        content: `Coordination sweep released expired quota-pending claim ${claim.file_path} from ${claim.session_id}; audit history retained.`,
        metadata: {
          kind: 'coordination-sweep',
          action: 'release-expired-quota-pending',
          task_id: claim.task_id,
          file_path: claim.file_path,
          branch: claim.branch,
          repo_root: claim.repo_root,
          owner_session_id: claim.session_id,
          handoff_observation_id,
          claimed_at: claim.claimed_at,
          expires_at,
          age_minutes: claim.age_minutes,
          now,
        },
      });
      store.storage.markClaimWeakExpired({
        task_id: claim.task_id,
        file_path: claim.file_path,
        session_id: claim.session_id,
        handoff_observation_id,
      });
      expireQuotaBatonObservationIfPending(store, claim.task_id, handoff_observation_id, now);
      store.storage.touchTask(claim.task_id, now);
      return observationId;
    });
    released.push({
      task_id: claim.task_id,
      branch: claim.branch,
      file_path: claim.file_path,
      session_id: claim.session_id,
      handoff_observation_id,
      expires_at,
      age_minutes: claim.age_minutes,
      cleanup_action: 'release_expired_quota_pending',
      reason: 'quota_pending_expired',
      audit_observation_id: auditId,
    });
  }
  return released;
}

function collectAgedQuotaPendingClaims(
  signals: ClaimSignal[],
  ageMinutesThreshold: number,
  alreadyReleased: ReleasedExpiredQuotaPendingClaim[],
): ClaimSignal[] {
  const seen = new Set<string>();
  for (const released of alreadyReleased) {
    seen.add(
      [
        released.task_id,
        released.file_path ?? '',
        released.session_id,
        released.handoff_observation_id,
      ].join('|'),
    );
  }
  const out: ClaimSignal[] = [];
  for (const claim of signals) {
    if (claim.state !== 'handoff_pending') continue;
    if (claim.handoff_observation_id === null) continue;
    if (claim.age_minutes < ageMinutesThreshold) continue;
    const key = staleClaimKey(claim);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(claim);
  }
  return out;
}

function releaseAgedQuotaPendingClaims(
  store: MemoryStore,
  claims: ClaimSignal[],
  now: number,
): ReleasedExpiredQuotaPendingClaim[] {
  const released: ReleasedExpiredQuotaPendingClaim[] = [];
  for (const claim of claims) {
    if (claim.handoff_observation_id === null) continue;
    const handoff_observation_id = claim.handoff_observation_id;
    const expires_at = typeof claim.expires_at === 'number' ? claim.expires_at : now;
    const auditId = store.storage.transaction(() => {
      const observationId = store.addObservation({
        session_id: 'coordination-sweep',
        task_id: claim.task_id,
        kind: 'coordination-sweep',
        content: `Coordination sweep released aged quota-pending claim ${claim.file_path} from ${claim.session_id} (age ${Math.round(claim.age_minutes)}m); audit history retained.`,
        metadata: {
          kind: 'coordination-sweep',
          action: 'release-aged-quota-pending',
          task_id: claim.task_id,
          file_path: claim.file_path,
          branch: claim.branch,
          repo_root: claim.repo_root,
          owner_session_id: claim.session_id,
          handoff_observation_id,
          claimed_at: claim.claimed_at,
          expires_at,
          age_minutes: claim.age_minutes,
          now,
        },
      });
      store.storage.markClaimWeakExpired({
        task_id: claim.task_id,
        file_path: claim.file_path,
        session_id: claim.session_id,
        handoff_observation_id,
      });
      expireQuotaBatonObservationIfPending(store, claim.task_id, handoff_observation_id, now);
      store.storage.touchTask(claim.task_id, now);
      return observationId;
    });
    released.push({
      task_id: claim.task_id,
      branch: claim.branch,
      file_path: claim.file_path,
      session_id: claim.session_id,
      handoff_observation_id,
      expires_at,
      age_minutes: claim.age_minutes,
      cleanup_action: 'release_aged_quota_pending',
      reason: 'quota_pending_aged',
      audit_observation_id: auditId,
    });
  }
  return released;
}

function expireQuotaBatonObservationIfPending(
  store: MemoryStore,
  task_id: number,
  observation_id: number,
  now: number,
): void {
  const obs = store.storage.getObservation(observation_id);
  if (!obs || obs.task_id !== task_id) return;
  if (obs.kind !== 'handoff' && obs.kind !== 'relay') return;
  let parsed: Record<string, unknown>;
  try {
    parsed = obs.metadata ? (JSON.parse(obs.metadata) as Record<string, unknown>) : {};
  } catch {
    return;
  }
  const status = typeof parsed.status === 'string' ? parsed.status : null;
  const expires_at = typeof parsed.expires_at === 'number' ? parsed.expires_at : null;
  if (status !== 'pending') return;
  if (expires_at === null || now < expires_at) return;
  parsed.status = 'expired';
  store.storage.updateObservationMetadata(observation_id, JSON.stringify(parsed));
}

function staleClaimKey(claim: { task_id: number; file_path: string; session_id: string }): string {
  return `${claim.task_id}\u0000${claim.file_path}\u0000${claim.session_id}`;
}

function claimKey(branch: string, filePath: string): string {
  return `${branch}\u0000${filePath}`;
}

function collectExpiredHandoffs(
  store: MemoryStore,
  tasks: TaskRow[],
  now: number,
): ExpiredHandoffSignal[] {
  const out: ExpiredHandoffSignal[] = [];
  for (const task of tasks) {
    for (const row of store.storage.taskObservationsByKind(task.id, 'handoff', 1_000)) {
      const meta = parseHandoff(row);
      if (!meta) continue;
      const effectivelyExpired =
        meta.status === 'expired' || (meta.status === 'pending' && now >= meta.expires_at);
      if (!effectivelyExpired) continue;
      out.push({
        observation_id: row.id,
        task_id: task.id,
        task_title: task.title,
        repo_root: task.repo_root,
        branch: task.branch,
        from_session_id: meta.from_session_id,
        from_agent: meta.from_agent,
        to_agent: meta.to_agent,
        to_session_id: meta.to_session_id,
        status: meta.status,
        expires_at: meta.expires_at,
        expired_minutes: elapsedMinutes(now, meta.expires_at),
        summary: meta.summary,
      });
    }
  }
  return out.sort((a, b) => b.expired_minutes - a.expired_minutes);
}

function collectExpiredMessages(
  store: MemoryStore,
  tasks: TaskRow[],
  now: number,
): ExpiredMessageSignal[] {
  const out: ExpiredMessageSignal[] = [];
  for (const task of tasks) {
    for (const row of store.storage.taskObservationsByKind(task.id, 'message', 1_000)) {
      const meta = parseMessage(row.metadata);
      if (!meta || meta.expires_at === null) continue;
      const effectivelyExpired =
        meta.status === 'expired' || (meta.status === 'unread' && now >= meta.expires_at);
      if (!effectivelyExpired) continue;
      out.push({
        observation_id: row.id,
        task_id: task.id,
        task_title: task.title,
        repo_root: task.repo_root,
        branch: task.branch,
        from_session_id: meta.from_session_id,
        from_agent: meta.from_agent,
        to_agent: meta.to_agent,
        to_session_id: meta.to_session_id,
        urgency: meta.urgency,
        status: meta.status,
        expires_at: meta.expires_at,
        expired_minutes: elapsedMinutes(now, meta.expires_at),
        preview: compactPreview(expandedContent(store, row.id, row.content)),
      });
    }
  }
  return out.sort((a, b) => b.expired_minutes - a.expired_minutes);
}

function collectDecayedProposals(
  store: MemoryStore,
  proposals: ProposalSystem,
  repoRoots: Set<string> | null,
  now: number,
): DecayedProposalSignal[] {
  const rows =
    repoRoots === null
      ? store.storage.listProposals(undefined)
      : dedupeById([...repoRoots].flatMap((repoRoot) => store.storage.listProposals(repoRoot)));
  return rows
    .filter((proposal) => proposal.status === 'pending')
    .map((proposal) => {
      const strength = proposals.currentStrength(proposal.id, now);
      return proposalSignal(store, proposal, strength, proposals.noiseFloor, now);
    })
    .filter((signal): signal is DecayedProposalSignal => signal !== null)
    .sort((a, b) => a.strength - b.strength || b.age_minutes - a.age_minutes);
}

function dedupeById<T extends { id: number }>(rows: T[]): T[] {
  const seen = new Set<number>();
  const out: T[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

function proposalSignal(
  store: MemoryStore,
  proposal: ProposalRow,
  strength: number,
  noiseFloor: number,
  now: number,
): DecayedProposalSignal | null {
  if (strength >= noiseFloor) return null;
  const reinforcements = store.storage.listReinforcements(proposal.id);
  return {
    proposal_id: proposal.id,
    repo_root: proposal.repo_root,
    branch: proposal.branch,
    summary: proposal.summary,
    proposed_by: proposal.proposed_by,
    proposed_at: proposal.proposed_at,
    age_minutes: elapsedMinutes(now, proposal.proposed_at),
    strength: roundStrength(strength),
    noise_floor: noiseFloor,
    reinforcement_count: new Set(reinforcements.map((row) => row.session_id)).size,
    touches_files: parseFiles(proposal.touches_files),
  };
}

function collectStaleHotFiles(
  store: MemoryStore,
  tasks: TaskRow[],
  now: number,
  thresholds: CoordinationSweepResult['thresholds'],
): StaleHotFileSignal[] {
  const out: StaleHotFileSignal[] = [];
  for (const task of tasks) {
    const byFile = groupPheromonesByFile(store.storage.listPheromonesForTask(task.id));
    for (const [filePath, rows] of byFile.entries()) {
      const originalStrength = rows.reduce((sum, row) => sum + row.strength, 0);
      if (originalStrength < thresholds.stale_hot_file_min_original_strength) continue;
      const currentStrength = rows.reduce(
        (sum, row) => sum + PheromoneSystem.decay(row.strength, row.deposited_at, now),
        0,
      );
      if (currentStrength >= thresholds.hot_file_noise_floor) continue;
      const latestDepositedAt = Math.max(...rows.map((row) => row.deposited_at));
      out.push({
        task_id: task.id,
        task_title: task.title,
        repo_root: task.repo_root,
        branch: task.branch,
        file_path: filePath,
        original_strength: roundStrength(originalStrength),
        current_strength: roundStrength(currentStrength),
        latest_deposited_at: latestDepositedAt,
        age_minutes: elapsedMinutes(now, latestDepositedAt),
        sessions: [...new Set(rows.map((row) => row.session_id))].sort(),
      });
    }
  }
  return out.sort(
    (a, b) => b.original_strength - a.original_strength || b.age_minutes - a.age_minutes,
  );
}

function collectBlockedDownstreamTasks(
  store: MemoryStore,
  repoRoots: Set<string> | null,
): BlockedDownstreamTaskSignal[] {
  const out: BlockedDownstreamTaskSignal[] = [];
  const plans =
    repoRoots === null
      ? listPlans(store, { limit: 2_000 })
      : [...repoRoots].flatMap((repo_root) => listPlans(store, { repo_root, limit: 2_000 }));
  for (const plan of plans) {
    for (const subtask of plan.subtasks) {
      if (subtask.status === 'completed' || subtask.blocked_by_count === 0) continue;
      out.push({
        plan_slug: plan.plan_slug,
        plan_title: plan.title,
        repo_root: plan.repo_root,
        task_id: subtask.task_id,
        subtask_index: subtask.subtask_index,
        subtask_title: subtask.title,
        status: subtask.status,
        blocked_by_count: subtask.blocked_by_count,
        blocked_by: blockersFor(subtask, plan.subtasks),
      });
    }
  }
  return out.sort(
    (a, b) =>
      b.blocked_by_count - a.blocked_by_count ||
      a.plan_slug.localeCompare(b.plan_slug) ||
      a.subtask_index - b.subtask_index,
  );
}

function collectStaleDownstreamBlockers(
  store: MemoryStore,
  repoRoots: Set<string> | null,
  now: number,
  thresholds: CoordinationSweepResult['thresholds'],
): StaleDownstreamBlockerSignal[] {
  const out: StaleDownstreamBlockerSignal[] = [];
  const plans =
    repoRoots === null
      ? listPlans(store, { limit: 2_000 })
      : [...repoRoots].flatMap((repo_root) => listPlans(store, { repo_root, limit: 2_000 }));

  for (const plan of plans) {
    for (const blocker of plan.subtasks) {
      if (blocker.status !== 'claimed') continue;
      const blockedDownstream = plan.subtasks.filter(
        (subtask) =>
          subtask.status !== 'completed' && subtask.blocked_by.includes(blocker.subtask_index),
      );
      if (blockedDownstream.length === 0) continue;

      for (const claim of staleBlockerClaims(store, blocker, now, thresholds)) {
        const unlockCandidate = blockedDownstream[0];
        if (!unlockCandidate) continue;
        out.push({
          plan_slug: plan.plan_slug,
          plan_title: plan.title,
          repo_root: plan.repo_root,
          task_id: blocker.task_id,
          subtask_index: blocker.subtask_index,
          subtask_title: blocker.title,
          file_path: claim.file_path,
          owner_session_id: claim.session_id,
          owner_agent: blocker.claimed_by_agent,
          claimed_at: claim.claimed_at,
          age_minutes: claim.classification.age_minutes,
          age_class: claim.classification.age_class,
          unlock_candidate: {
            task_id: unlockCandidate.task_id,
            subtask_index: unlockCandidate.subtask_index,
            title: unlockCandidate.title,
            file_scope: unlockCandidate.file_scope,
          },
          blocked_downstream: blockedDownstream.map((subtask) => ({
            task_id: subtask.task_id,
            subtask_index: subtask.subtask_index,
            title: subtask.title,
            status: subtask.status,
          })),
          cleanup_action: 'release_and_requeue_stale_blocker',
          cleanup_summary:
            'release stale advisory file claim and append an available plan-subtask marker; audit observations stay intact',
        });
      }
    }
  }

  return out.sort(
    (a, b) =>
      b.age_minutes - a.age_minutes ||
      a.plan_slug.localeCompare(b.plan_slug) ||
      a.subtask_index - b.subtask_index ||
      a.file_path.localeCompare(b.file_path),
  );
}

function staleBlockerClaims(
  store: MemoryStore,
  blocker: SubtaskInfo,
  now: number,
  thresholds: CoordinationSweepResult['thresholds'],
): Array<{
  file_path: string;
  session_id: string;
  claimed_at: number;
  classification: ReturnType<typeof classifyClaimAge>;
}> {
  const owner = blocker.claimed_by_session_id;
  if (!owner) return [];
  const currentClaims = store.storage
    .listClaims(blocker.task_id)
    .filter((claim) => claim.session_id === owner);
  const rows =
    currentClaims.length > 0
      ? currentClaims
      : fallbackClaimRows(blocker, owner, blocker.claimed_at);

  return rows
    .map((claim) => ({
      file_path: claim.file_path,
      session_id: claim.session_id,
      claimed_at: claim.claimed_at,
      classification: classifyClaimAge(claim, {
        now,
        claim_stale_minutes: thresholds.stale_claim_minutes,
      }),
    }))
    .filter((claim) => !isStrongClaimAge(claim.classification));
}

function fallbackClaimRows(
  blocker: SubtaskInfo,
  owner: string,
  claimedAt: number | null,
): TaskClaimRow[] {
  if (claimedAt === null) return [];
  const fileScope = blocker.file_scope.length > 0 ? blocker.file_scope : ['(unscoped)'];
  return fileScope.map((file_path) => ({
    task_id: blocker.task_id,
    file_path,
    session_id: owner,
    claimed_at: claimedAt,
    state: 'active',
    expires_at: null,
    handoff_observation_id: null,
  }));
}

function releaseStaleDownstreamBlockers(
  store: MemoryStore,
  blockers: StaleDownstreamBlockerSignal[],
  now: number,
): ReleasedStaleDownstreamBlocker[] {
  const grouped = new Map<string, StaleDownstreamBlockerSignal[]>();
  for (const blocker of blockers) {
    const key = `${blocker.task_id}\u0000${blocker.owner_session_id}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(blocker);
    grouped.set(key, bucket);
  }

  const released: ReleasedStaleDownstreamBlocker[] = [];
  for (const group of grouped.values()) {
    const first = group[0];
    if (!first) continue;
    const result = store.storage.transaction(() => {
      let releasedClaimCount = 0;
      for (const blocker of group) {
        if (blocker.file_path === '(unscoped)') continue;
        const before = store.storage.getClaim(blocker.task_id, blocker.file_path);
        store.storage.releaseClaim({
          task_id: blocker.task_id,
          file_path: blocker.file_path,
          session_id: blocker.owner_session_id,
        });
        const after = store.storage.getClaim(blocker.task_id, blocker.file_path);
        if (before && !after) releasedClaimCount++;
      }
      const releasedFiles = group
        .map((blocker) => blocker.file_path)
        .filter((filePath) => filePath !== '(unscoped)');
      const auditId = store.addObservation({
        session_id: 'coordination-sweep',
        task_id: first.task_id,
        kind: 'coordination-sweep',
        content: `Coordination sweep released ${releasedClaimCount} stale downstream blocker claim(s) for ${first.plan_slug}/sub-${first.subtask_index}; audit history retained.`,
        metadata: {
          kind: 'coordination-sweep',
          action: 'release-stale-downstream-blocker',
          plan_slug: first.plan_slug,
          subtask_index: first.subtask_index,
          owner_session_id: first.owner_session_id,
          released_files: releasedFiles,
          blocked_downstream: first.blocked_downstream,
          now,
        },
      });
      const requeueId = store.addObservation({
        session_id: 'coordination-sweep',
        task_id: first.task_id,
        kind: 'plan-subtask-claim',
        content: `Coordination sweep requeued ${first.plan_slug}/sub-${first.subtask_index} after stale downstream blocker release.`,
        metadata: {
          kind: 'plan-subtask-claim',
          status: 'available',
          subtask_index: first.subtask_index,
          session_id: 'coordination-sweep',
          agent: 'coordination-sweep',
          previous_session_id: first.owner_session_id,
          audit_observation_id: auditId,
          reason: 'stale downstream blocker released',
        },
      });
      store.storage.touchTask(first.task_id, now);
      return {
        plan_slug: first.plan_slug,
        task_id: first.task_id,
        subtask_index: first.subtask_index,
        released_claim_count: releasedClaimCount,
        audit_observation_id: auditId,
        requeue_observation_id: requeueId,
      };
    });
    released.push(result);
  }

  return released.sort(
    (a, b) =>
      a.plan_slug.localeCompare(b.plan_slug) ||
      a.subtask_index - b.subtask_index ||
      a.task_id - b.task_id,
  );
}

function blockersFor(
  subtask: SubtaskInfo,
  all: SubtaskInfo[],
): BlockedDownstreamTaskSignal['blocked_by'] {
  return subtask.blocked_by
    .map((index) => all.find((candidate) => candidate.subtask_index === index))
    .filter((candidate): candidate is SubtaskInfo => candidate !== undefined)
    .map((blocker) => ({
      subtask_index: blocker.subtask_index,
      title: blocker.title,
      status: blocker.status,
      task_id: blocker.task_id,
    }));
}

function groupPheromonesByFile(rows: PheromoneRow[]): Map<string, PheromoneRow[]> {
  const byFile = new Map<string, PheromoneRow[]>();
  for (const row of rows) {
    const list = byFile.get(row.file_path) ?? [];
    list.push(row);
    byFile.set(row.file_path, list);
  }
  return byFile;
}

function parseHandoff(row: ObservationRow): HandoffMetadata | null {
  if (!row.metadata) return null;
  try {
    const parsed = JSON.parse(row.metadata) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const meta = parsed as Partial<HandoffMetadata>;
    if (meta.kind !== 'handoff' || typeof meta.status !== 'string') return null;
    const handoff = parsed as HandoffMetadata;
    if (typeof handoff.expires_at !== 'number' || !Number.isFinite(handoff.expires_at)) {
      handoff.expires_at = row.ts + DEFAULT_HANDOFF_TTL_MS;
    }
    return handoff;
  } catch {
    return null;
  }
}

function parseFiles(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function compactPreview(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function expandedContent(store: MemoryStore, observationId: number, fallback: string): string {
  return store.getObservations([observationId], { expand: true })[0]?.content ?? fallback;
}

function elapsedMinutes(now: number, then: number): number {
  return Math.max(0, Math.floor((now - then) / 60_000));
}

function roundStrength(value: number): number {
  return Number(value.toFixed(3));
}
