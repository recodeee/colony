import type { ObservationRow, TaskClaimRow, TaskRow } from '@colony/storage';
import { type HivemindSession, readHivemind } from './hivemind.js';
import { inferIdeFromSessionId } from './infer-ide.js';
import type { MemoryStore } from './memory-store.js';
import { type PlanInfo, type SubtaskInfo, listPlans, readSubtaskByBranch } from './plan.js';
import {
  type MessageUrgency,
  type RelayReason,
  TaskThread,
  isMessageAddressedTo,
  parseMessage,
} from './task-thread.js';

const DEFAULT_STRANDED_AFTER_MS = 10 * 60_000;
const RESCUE_RELAY_TTL_MS = 30 * 60_000;
const ONE_LINE_LIMIT = 240;
const MINUTE_MS = 60_000;

export type BlockingUrgency = 'blocks_downstream' | 'local_claim';
export type MessageAttentionState =
  | 'blocking_message'
  | 'needs_reply_message'
  | 'fyi_message'
  | 'no_pending_message';

export interface StrandedRescueOptions {
  stranded_after_ms?: number;
  dry_run?: boolean;
  session_id?: string;
}

export interface BulkStrandedRescueOptions {
  stranded_after_ms?: number;
  dry_run?: boolean;
  now?: number;
  session_id?: string;
}

export interface BulkStrandedClaim {
  task_id: number;
  file_path: string;
  claimed_at: number;
  repo_root: string | null;
  branch: string | null;
}

export interface BulkStrandedSession {
  session_id: string;
  agent: string;
  repo_root: string;
  branch: string;
  repo_roots: string[];
  branches: string[];
  task_ids: number[];
  last_activity: number;
  held_claim_count: number;
  held_claims: BulkStrandedClaim[];
  suggested_action: string;
  audit_observation_id?: number;
}

export interface BulkStrandedRescueOutcome {
  dry_run: boolean;
  scanned: number;
  stranded: BulkStrandedSession[];
  rescued: BulkStrandedSession[];
  skipped: Array<{ session_id: string; reason: string }>;
  released_claim_count: number;
  audit_observation_ids: number[];
}

export interface StrandedRescueOutcome {
  scanned: number;
  rescued: Array<{
    session_id: string;
    task_id: number;
    relay_observation_id: number;
    inherited_claims: string[];
    rescue_reason: string;
    plan_slug?: string;
    wave_index?: number;
    blocked_downstream_count?: number;
    suggested_action?: string;
    blocking_urgency: BlockingUrgency;
    stale_age_minutes: number;
    message_attention_state: MessageAttentionState;
  }>;
  skipped: Array<{ session_id: string; reason: string }>;
}

interface StrandedSessionRow {
  session_id?: string;
  id?: string;
  ide?: string | null;
  repo_root?: string | null;
  cwd?: string | null;
  worktree_path?: string | null;
  branch?: string | null;
  last_observation_ts?: number | string | null;
  held_claims_json?: string | null;
  last_tool_error?: string | null;
}

interface ParsedHeldClaim {
  task_id: number;
  file_path: string;
  claimed_at: number;
}

interface RecentToolErrorRow {
  tool?: string | null;
  tool_name?: string | null;
  name?: string | null;
  message?: string | null;
  error?: string | null;
  content?: string | null;
  ts?: number | string | null;
}

interface RescueStorage {
  findStrandedSessions(args: { stranded_after_ms: number }): StrandedSessionRow[];
  recentToolErrors?: unknown;
}

interface OrderedPlanContext {
  plan_slug: string;
  wave_index: number;
  blocked_downstream_count: number;
  suggested_action?: string;
}

interface RescueJob {
  session_id: string;
  task_id: number;
  claims: TaskClaimRow[];
  lastToolError: RecentToolErrorRow | null;
  relayReason: RelayReason;
  rescue_reason: string;
  from_agent: string;
  last_observation_ts: number | null;
  one_line: string;
  stale_age_ms: number;
  blocking_urgency: BlockingUrgency;
  message_attention_state: MessageAttentionState;
  planContext?: OrderedPlanContext;
}

export function rescueStrandedSessions(
  store: MemoryStore,
  options: StrandedRescueOptions = {},
): StrandedRescueOutcome {
  const stranded_after_ms = options.stranded_after_ms ?? DEFAULT_STRANDED_AFTER_MS;
  const dryRun = options.dry_run ?? false;
  const now = Date.now();
  const storage = store.storage as typeof store.storage & RescueStorage;
  const requestedSessionId = options.session_id?.trim();
  const allCandidates = storage.findStrandedSessions({ stranded_after_ms });
  const candidates = requestedSessionId
    ? allCandidates.filter((candidate) => candidateSessionId(candidate) === requestedSessionId)
    : allCandidates;
  const outcome: StrandedRescueOutcome = { scanned: candidates.length, rescued: [], skipped: [] };
  const orderedPlanContexts = orderedPlanContextByTask(store);
  const jobs: RescueJob[] = [];

  if (requestedSessionId && candidates.length === 0) {
    outcome.skipped.push({ session_id: requestedSessionId, reason: 'not stranded' });
  }

  for (const candidate of candidates) {
    const session_id = candidateSessionId(candidate);
    if (!session_id) {
      outcome.skipped.push({ session_id: '', reason: 'missing session_id' });
      continue;
    }

    const repoRoot = candidateRepoRoot(candidate);
    const snapshot = readHivemind({
      ...(repoRoot !== undefined ? { repoRoot } : {}),
      limit: 100,
    });
    if (!isLiveActiveSession(candidate, snapshot.sessions)) {
      outcome.skipped.push({ session_id, reason: 'session not alive' });
      continue;
    }

    const claimsByTask = groupClaimsByTask(store, session_id);
    if (claimsByTask.size === 0) {
      outcome.skipped.push({ session_id, reason: 'no claims' });
      continue;
    }

    const lastToolError = latestToolError(storage, session_id, candidate);
    const relayReason = relayReasonFor(lastToolError);
    const rescue_reason = rescueReasonFor(lastToolError);
    const from_agent = inferAgent(session_id);
    const last_observation_ts = lastObservationTs(store, session_id, candidate);
    const one_line = rescueOneLine(store, session_id);

    for (const [task_id, claims] of claimsByTask.entries()) {
      const planContext = orderedPlanContexts.get(task_id);
      const job: RescueJob = {
        session_id,
        task_id,
        claims,
        lastToolError,
        relayReason,
        rescue_reason,
        from_agent,
        one_line,
        last_observation_ts,
        stale_age_ms: staleAgeMs({ now, last_observation_ts, claims }),
        blocking_urgency: blockingUrgencyFor(planContext),
        message_attention_state: messageAttentionState(store, {
          task_id,
          session_id,
          agent: from_agent,
          now,
        }),
      };
      if (planContext) job.planContext = planContext;
      jobs.push(job);
    }
  }

  for (const job of jobs.sort(compareRescueJobs)) {
    const inherited_claims = job.claims.map((claim) => claim.file_path);
    const planMetadata = orderedPlanMetadata(job.planContext);
    const observerMetadata = {
      kind: 'observer-note',
      action: 'rescue-relay',
      stranded_session_id: job.session_id,
      task_id: job.task_id,
      last_observation_ts: job.last_observation_ts,
      last_tool_error: renderToolError(job.lastToolError),
      claim_count: inherited_claims.length,
      rescue_reason: job.rescue_reason,
      dry_run: dryRun,
      blocking_urgency: job.blocking_urgency,
      stale_age_minutes: ageMinutes(job.stale_age_ms),
      message_attention_state: job.message_attention_state,
      ...planMetadata,
    };
    store.addObservation({
      session_id: job.session_id,
      kind: 'observer-note',
      task_id: job.task_id,
      content: `Preparing rescue relay for stranded session ${job.session_id} on task ${job.task_id}; ${inherited_claims.length} claim(s) will be released.${orderedPlanSentence(job.planContext)}`,
      metadata: observerMetadata,
    });

    if (dryRun) {
      outcome.rescued.push({
        session_id: job.session_id,
        task_id: job.task_id,
        relay_observation_id: -1,
        inherited_claims,
        rescue_reason: job.rescue_reason,
        blocking_urgency: job.blocking_urgency,
        stale_age_minutes: ageMinutes(job.stale_age_ms),
        message_attention_state: job.message_attention_state,
        ...planMetadata,
      });
      continue;
    }

    const task = store.storage.getTask(job.task_id);
    const relay_observation_id = new TaskThread(store, job.task_id).relay({
      from_session_id: job.session_id,
      from_agent: job.from_agent,
      reason: job.relayReason,
      one_line: job.one_line,
      base_branch: baseBranchFor(task),
      to_agent: 'any',
      expires_in_ms: RESCUE_RELAY_TTL_MS,
    });

    store.addObservation({
      session_id: job.session_id,
      kind: 'rescue-relay',
      task_id: job.task_id,
      content: `Rescue relay emitted for stranded session ${job.session_id}; dropped ${inherited_claims.length} claim(s).${orderedPlanSentence(job.planContext)}`,
      metadata: {
        stranded_session_id: job.session_id,
        last_observation_ts: job.last_observation_ts,
        last_tool_error: renderToolError(job.lastToolError),
        claim_count: inherited_claims.length,
        rescue_reason: job.rescue_reason,
        relay_observation_id,
        blocking_urgency: job.blocking_urgency,
        stale_age_minutes: ageMinutes(job.stale_age_ms),
        message_attention_state: job.message_attention_state,
        ...planMetadata,
      },
    });

    outcome.rescued.push({
      session_id: job.session_id,
      task_id: job.task_id,
      relay_observation_id,
      inherited_claims,
      rescue_reason: job.rescue_reason,
      blocking_urgency: job.blocking_urgency,
      stale_age_minutes: ageMinutes(job.stale_age_ms),
      message_attention_state: job.message_attention_state,
      ...planMetadata,
    });
  }

  return outcome;
}

export function bulkRescueStrandedSessions(
  store: MemoryStore,
  options: BulkStrandedRescueOptions = {},
): BulkStrandedRescueOutcome {
  const stranded_after_ms = options.stranded_after_ms ?? DEFAULT_STRANDED_AFTER_MS;
  const dryRun = options.dry_run ?? true;
  const now = options.now ?? Date.now();
  const storage = store.storage as typeof store.storage & RescueStorage;
  const requestedSessionId = options.session_id?.trim();
  const allCandidates = storage.findStrandedSessions({ stranded_after_ms });
  const candidates = requestedSessionId
    ? allCandidates.filter((candidate) => candidateSessionId(candidate) === requestedSessionId)
    : allCandidates;
  const outcome: BulkStrandedRescueOutcome = {
    dry_run: dryRun,
    scanned: candidates.length,
    stranded: [],
    rescued: [],
    skipped: [],
    released_claim_count: 0,
    audit_observation_ids: [],
  };

  if (requestedSessionId && candidates.length === 0) {
    outcome.skipped.push({ session_id: requestedSessionId, reason: 'not stranded' });
  }

  for (const candidate of candidates) {
    const session_id = candidateSessionId(candidate);
    if (!session_id) {
      outcome.skipped.push({ session_id: '', reason: 'missing session_id' });
      continue;
    }

    const claims = heldClaimsForCandidate(store, candidate);
    if (claims.length === 0) {
      outcome.skipped.push({ session_id, reason: 'no claims' });
      continue;
    }

    const row = strandedSessionSummary(store, candidate, claims, now);
    outcome.stranded.push(row);
    if (dryRun) continue;

    // BEGIN IMMEDIATE so the re-read of claims inside the transaction and all
    // subsequent deletes/writes are atomic across processes. Two concurrent
    // rescue callers could otherwise both read the same held claims outside
    // the transaction and then both attempt to release and audit them.
    const audit_observation_id = store.storage.transaction(
      () => {
        // Re-read claims inside the transaction so the set we release matches
        // exactly what is visible under the write lock — guards against a
        // concurrent caller having already released some of them between the
        // outer read and this point.
        const liveClaims = heldClaimsForCandidate(store, candidate);
        if (liveClaims.length === 0) return -1;
        for (const claim of liveClaims) {
          store.storage.releaseClaim({
            task_id: claim.task_id,
            file_path: claim.file_path,
            session_id,
          });
        }
        const requeuedSubtasks = requeueReleasedPlanSubtasks(store, {
          session_id,
          claims: liveClaims,
          agent: row.agent,
        });
        const auditId = store.addObservation({
          session_id,
          kind: 'rescue-stranded',
          content: `Bulk rescue released ${liveClaims.length} claim(s) for stranded session ${session_id}; audit history retained.`,
          metadata: {
            kind: 'rescue-stranded',
            action: 'bulk-release-claims',
            stranded_session_id: session_id,
            agent: row.agent,
            repo_root: row.repo_root,
            branch: row.branch,
            repo_roots: row.repo_roots,
            branches: row.branches,
            task_ids: row.task_ids,
            last_activity: row.last_activity,
            held_claim_count: liveClaims.length,
            requeued_plan_subtasks: requeuedSubtasks,
            released_claims: liveClaims.map((claim) => ({
              task_id: claim.task_id,
              file_path: claim.file_path,
              claimed_at: claim.claimed_at,
            })),
          },
        });
        store.storage.endSession(session_id, now);
        return auditId;
      },
      { immediate: true },
    );

    // -1 means another concurrent caller already released the claims before
    // this transaction acquired the write lock — skip rather than double-count.
    if (audit_observation_id === -1) {
      outcome.skipped.push({ session_id, reason: 'claims already released by concurrent caller' });
      continue;
    }

    const rescued = {
      ...row,
      audit_observation_id,
      suggested_action: `released ${claims.length} claim(s), marked session rescued, kept audit history`,
    };
    outcome.rescued.push(rescued);
    outcome.released_claim_count += claims.length;
    outcome.audit_observation_ids.push(audit_observation_id);
  }

  return outcome;
}

/**
 * Default age at which an unattended plan-subtask claim is considered stale
 * enough to auto-release. Matches `STALE_BLOCKER_WINDOW_MS` in the MCP ready-
 * queue tool so both surfaces share one definition of "dead claim".
 */
export const STALE_PLAN_SUBTASK_CLAIM_MS = 60 * 60_000;

export interface AutoReleaseStaleClaimsOptions {
  stale_after_ms?: number;
  now?: number;
}

export interface AutoReleasedStalePlanSubtask {
  plan_slug: string;
  subtask_index: number;
  task_id: number;
  age_minutes: number;
  owner_session_id: string | null;
  owner_agent: string | null;
}

export interface AutoReleaseStaleClaimsOutcome {
  released: AutoReleasedStalePlanSubtask[];
}

/**
 * Sweep plan subtasks whose `claimed` state has been held longer than
 * `stale_after_ms` (default 1h) and write a `plan-subtask-claim` observation
 * flipping them back to `available`. This is the server-side replacement for
 * having an agent call `rescue_stranded_scan` — when the worker fleet is
 * policy-prohibited from rescuing other agents' claims, the queue itself
 * has to be the one to release them or the wave deadlocks.
 *
 * The release is idempotent at the observation level: writing a second
 * `status: 'available'` observation for an already-released subtask is a
 * no-op for status (latest-wins) and only adds a row to the audit log.
 * Callers pass already-loaded plans rather than re-reading from storage so
 * the hot ready-queue path doesn't pay for an extra listPlans on every call.
 */
export function autoReleaseStalePlanSubtaskClaims(
  store: MemoryStore,
  plans: PlanInfo[],
  options: AutoReleaseStaleClaimsOptions = {},
): AutoReleaseStaleClaimsOutcome {
  const staleAfterMs = options.stale_after_ms ?? STALE_PLAN_SUBTASK_CLAIM_MS;
  const now = options.now ?? Date.now();
  const released: AutoReleasedStalePlanSubtask[] = [];

  for (const plan of plans) {
    for (const subtask of plan.subtasks) {
      if (subtask.status !== 'claimed') continue;
      if (subtask.claimed_at === null) continue;
      const ageMs = now - subtask.claimed_at;
      if (ageMs < staleAfterMs) continue;

      const located = readSubtaskByBranch(
        store,
        `spec/${plan.plan_slug}/sub-${subtask.subtask_index}`,
      );
      if (!located || located.info.status !== 'claimed') continue;

      const owner_session_id = located.info.claimed_by_session_id ?? null;
      const owner_agent = located.info.claimed_by_agent ?? null;
      const ageMinutes = Math.floor(ageMs / 60_000);

      store.addObservation({
        session_id: owner_session_id ?? 'system',
        kind: 'plan-subtask-claim',
        task_id: located.task_id,
        content: `Auto-released ${plan.plan_slug}/sub-${subtask.subtask_index} after ${ageMinutes}m stale (held by ${owner_agent ?? 'unknown agent'}); the ready-queue surfaces it to the next eligible worker on the same tick.`,
        metadata: {
          kind: 'plan-subtask-claim',
          status: 'available',
          session_id: owner_session_id ?? '',
          agent: owner_agent ?? '',
          plan_slug: plan.plan_slug,
          subtask_index: subtask.subtask_index,
          rescue_reason: 'auto-released-stale-claim',
          stale_age_ms: ageMs,
        },
      });

      released.push({
        plan_slug: plan.plan_slug,
        subtask_index: subtask.subtask_index,
        task_id: located.task_id,
        age_minutes: ageMinutes,
        owner_session_id,
        owner_agent,
      });
    }
  }

  return { released };
}

function requeueReleasedPlanSubtasks(
  store: MemoryStore,
  args: { session_id: string; claims: ParsedHeldClaim[]; agent: string },
): Array<{ plan_slug: string; subtask_index: number; task_id: number }> {
  const requeued: Array<{ plan_slug: string; subtask_index: number; task_id: number }> = [];
  const taskIds = [...new Set(args.claims.map((claim) => claim.task_id))];
  for (const taskId of taskIds) {
    const task = store.storage.getTask(taskId);
    if (!task) continue;
    const located = readSubtaskByBranch(store, task.branch);
    if (!located) continue;
    if (located.info.status !== 'claimed') continue;
    if (located.info.claimed_by_session_id !== args.session_id) continue;

    store.addObservation({
      session_id: args.session_id,
      kind: 'plan-subtask-claim',
      task_id: taskId,
      content: `Bulk rescue re-queued ${located.info.parent_plan_slug}/sub-${located.info.subtask_index} after releasing stranded session ${args.session_id}.`,
      metadata: {
        kind: 'plan-subtask-claim',
        status: 'available',
        session_id: args.session_id,
        agent: args.agent,
        plan_slug: located.info.parent_plan_slug,
        subtask_index: located.info.subtask_index,
        rescue_reason: 'bulk-stranded-release',
      },
    });
    requeued.push({
      plan_slug: located.info.parent_plan_slug,
      subtask_index: located.info.subtask_index,
      task_id: taskId,
    });
  }
  return requeued;
}

function compareRescueJobs(left: RescueJob, right: RescueJob): number {
  const blockingUrgency = blockingUrgencyRank(right) - blockingUrgencyRank(left);
  if (blockingUrgency !== 0) return blockingUrgency;

  const age = right.stale_age_ms - left.stale_age_ms;
  if (age !== 0) return age;

  const impact =
    (right.planContext?.blocked_downstream_count ?? 0) -
    (left.planContext?.blocked_downstream_count ?? 0);
  if (impact !== 0) return impact;

  const attention =
    attentionRank(right.message_attention_state) - attentionRank(left.message_attention_state);
  if (attention !== 0) return attention;

  return left.task_id - right.task_id;
}

function blockingUrgencyFor(context: OrderedPlanContext | undefined): BlockingUrgency {
  return (context?.blocked_downstream_count ?? 0) > 0 ? 'blocks_downstream' : 'local_claim';
}

function blockingUrgencyRank(job: RescueJob): number {
  return job.blocking_urgency === 'blocks_downstream' ? 1 : 0;
}

function staleAgeMs(args: {
  now: number;
  last_observation_ts: number | null;
  claims: TaskClaimRow[];
}): number {
  const ages = [
    args.last_observation_ts !== null ? args.now - args.last_observation_ts : 0,
    ...args.claims.map((claim) => args.now - claim.claimed_at),
  ];
  return Math.max(0, ...ages);
}

function ageMinutes(ageMs: number): number {
  return Math.max(0, Math.floor(ageMs / MINUTE_MS));
}

function messageAttentionState(
  store: MemoryStore,
  args: { task_id: number; session_id: string; agent: string; now: number },
): MessageAttentionState {
  let best: MessageUrgency | null = null;
  for (const row of store.storage.taskObservationsByKind(args.task_id, 'message', 50)) {
    if (row.session_id === args.session_id) continue;
    const meta = parseMessage(row.metadata);
    if (!meta) continue;
    if (meta.status !== 'unread') continue;
    if (meta.expires_at !== null && args.now > meta.expires_at) continue;
    if (!isMessageAddressedTo(meta, args.session_id, args.agent)) continue;
    if (best === 'blocking') continue;
    if (meta.urgency === 'blocking' || best === null) {
      best = meta.urgency;
    } else if (meta.urgency === 'needs_reply' && best === 'fyi') {
      best = meta.urgency;
    }
  }

  if (best === 'blocking') return 'blocking_message';
  if (best === 'needs_reply') return 'needs_reply_message';
  if (best === 'fyi') return 'fyi_message';
  return 'no_pending_message';
}

function attentionRank(state: MessageAttentionState): number {
  switch (state) {
    case 'blocking_message':
      return 3;
    case 'needs_reply_message':
      return 2;
    case 'fyi_message':
      return 1;
    case 'no_pending_message':
      return 0;
  }
}

function orderedPlanContextByTask(store: MemoryStore): Map<number, OrderedPlanContext> {
  const contexts = new Map<number, OrderedPlanContext>();
  for (const plan of listPlans(store, { limit: 2_000 })) {
    const waveIndexes = waveIndexesFor(plan.subtasks);
    for (const subtask of plan.subtasks) {
      const blocked_downstream_count = blockedDownstreamCount(plan, subtask);
      contexts.set(subtask.task_id, {
        plan_slug: plan.plan_slug,
        wave_index: waveIndexes.get(subtask.subtask_index) ?? 0,
        blocked_downstream_count,
        ...(blocked_downstream_count > 0
          ? {
              suggested_action:
                'message stalled owner or reassign this sub-task before later waves can continue',
            }
          : {}),
      });
    }
  }
  return contexts;
}

function waveIndexesFor(subtasks: SubtaskInfo[]): Map<number, number> {
  const byIndex = new Map(subtasks.map((subtask) => [subtask.subtask_index, subtask]));
  const memo = new Map<number, number>();

  const visit = (index: number): number => {
    const cached = memo.get(index);
    if (cached !== undefined) return cached;
    const subtask = byIndex.get(index);
    if (!subtask || subtask.depends_on.length === 0) {
      memo.set(index, 0);
      return 0;
    }
    const wave = Math.max(...subtask.depends_on.map(visit)) + 1;
    memo.set(index, wave);
    return wave;
  };

  for (const subtask of subtasks) visit(subtask.subtask_index);
  return memo;
}

function blockedDownstreamCount(plan: PlanInfo, blocker: SubtaskInfo): number {
  return plan.subtasks.filter((subtask) => {
    if (subtask.subtask_index === blocker.subtask_index || subtask.status === 'completed') {
      return false;
    }
    return dependsOnTransitive(subtask, blocker.subtask_index, plan.subtasks);
  }).length;
}

function dependsOnTransitive(
  subtask: SubtaskInfo,
  dependencyIndex: number,
  allSubtasks: SubtaskInfo[],
): boolean {
  const byIndex = new Map(allSubtasks.map((item) => [item.subtask_index, item]));
  const visited = new Set<number>();
  const stack = [...subtask.depends_on];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || visited.has(current)) continue;
    if (current === dependencyIndex) return true;
    visited.add(current);
    stack.push(...(byIndex.get(current)?.depends_on ?? []));
  }
  return false;
}

function orderedPlanMetadata(context: OrderedPlanContext | undefined): Partial<OrderedPlanContext> {
  if (!context) return {};
  return {
    plan_slug: context.plan_slug,
    wave_index: context.wave_index,
    blocked_downstream_count: context.blocked_downstream_count,
    ...(context.suggested_action ? { suggested_action: context.suggested_action } : {}),
  };
}

function orderedPlanSentence(context: OrderedPlanContext | undefined): string {
  if (!context) return '';
  const waveNumber = context.wave_index + 1;
  if (context.blocked_downstream_count === 0) {
    return ` Plan ${context.plan_slug} wave ${waveNumber} has no blocked downstream sub-tasks.`;
  }
  return ` Plan ${context.plan_slug} wave ${waveNumber} blocks ${context.blocked_downstream_count} downstream sub-task(s).`;
}

function groupClaimsByTask(store: MemoryStore, session_id: string): Map<number, TaskClaimRow[]> {
  const grouped = new Map<number, TaskClaimRow[]>();
  for (const task of store.storage.listTasks(1_000)) {
    const claims = store.storage
      .listClaims(task.id)
      .filter((claim) => claim.session_id === session_id);
    if (claims.length > 0) grouped.set(task.id, claims);
  }
  return grouped;
}

function heldClaimsForCandidate(
  store: MemoryStore,
  candidate: StrandedSessionRow,
): ParsedHeldClaim[] {
  const parsed = parseHeldClaims(candidate.held_claims_json);
  if (parsed.length > 0) return parsed;
  const session_id = candidateSessionId(candidate);
  if (!session_id) return [];
  return [...groupClaimsByTask(store, session_id).values()].flat().map((claim) => ({
    task_id: claim.task_id,
    file_path: claim.file_path,
    claimed_at: claim.claimed_at,
  }));
}

function parseHeldClaims(raw: string | null | undefined): ParsedHeldClaim[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isParsedHeldClaim);
  } catch {
    return [];
  }
}

function isParsedHeldClaim(value: unknown): value is ParsedHeldClaim {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.task_id === 'number' &&
    Number.isFinite(record.task_id) &&
    typeof record.file_path === 'string' &&
    record.file_path.length > 0 &&
    typeof record.claimed_at === 'number' &&
    Number.isFinite(record.claimed_at)
  );
}

function strandedSessionSummary(
  store: MemoryStore,
  candidate: StrandedSessionRow,
  claims: ParsedHeldClaim[],
  now: number,
): BulkStrandedSession {
  const session_id = candidateSessionId(candidate) ?? '';
  const taskById = new Map(
    claims.map((claim) => [claim.task_id, store.storage.getTask(claim.task_id)] as const),
  );
  const claimSummaries = claims.map((claim) => {
    const task = taskById.get(claim.task_id);
    return {
      ...claim,
      repo_root: task?.repo_root ?? null,
      branch: task?.branch ?? null,
    };
  });
  const repoRoots = uniqueStrings([
    ...claimSummaries.map((claim) => claim.repo_root),
    candidateRepoRoot(candidate) ?? null,
  ]);
  const branches = uniqueStrings([
    ...claimSummaries.map((claim) => claim.branch),
    typeof candidate.branch === 'string' ? candidate.branch : null,
  ]);
  const taskIds = [...new Set(claims.map((claim) => claim.task_id))].sort((a, b) => a - b);
  const last_activity = lastObservationTs(store, session_id, candidate) ?? now;
  return {
    session_id,
    agent: candidateAgent(candidate, session_id),
    repo_root: summarizeValues(repoRoots),
    branch: summarizeValues(branches),
    repo_roots: repoRoots,
    branches,
    task_ids: taskIds,
    last_activity,
    held_claim_count: claims.length,
    held_claims: claimSummaries,
    suggested_action: `would release ${claims.length} claim(s), mark session rescued, keep audit history`,
  };
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())))].sort();
}

function summarizeValues(values: string[]): string {
  if (values.length === 0) return 'unknown';
  if (values.length === 1) return values[0] ?? 'unknown';
  return `multiple (${values.length})`;
}

function candidateAgent(candidate: StrandedSessionRow, session_id: string): string {
  if (candidate.ide && candidate.ide !== 'unknown') return agentNameForIde(candidate.ide);
  return inferAgent(session_id);
}

function agentNameForIde(ide: string): string {
  if (ide === 'claude-code') return 'claude';
  return ide;
}

function candidateSessionId(candidate: StrandedSessionRow): string | undefined {
  const id = candidate.session_id ?? candidate.id;
  return typeof id === 'string' && id.trim() ? id : undefined;
}

function candidateRepoRoot(candidate: StrandedSessionRow): string | undefined {
  const root = candidate.repo_root ?? candidate.cwd;
  return typeof root === 'string' && root.trim() ? root : undefined;
}

function isLiveActiveSession(candidate: StrandedSessionRow, sessions: HivemindSession[]): boolean {
  const session_id = candidateSessionId(candidate);
  if (!session_id) return false;
  const candidateWorktree = normalizePath(candidate.worktree_path);
  return sessions.some((session) => {
    if (session.source !== 'active-session' || session.activity === 'dead') return false;
    if (session.session_key === session_id) return true;
    if (session.file_path.includes(session_id)) return true;
    if (candidateWorktree && normalizePath(session.worktree_path) === candidateWorktree) {
      return true;
    }
    return false;
  });
}

function latestToolError(
  storage: typeof MemoryStore.prototype.storage & RescueStorage,
  session_id: string,
  candidate: StrandedSessionRow,
): RecentToolErrorRow | null {
  const rows = recentToolErrors(storage, session_id);
  if (rows.length > 0) {
    return rows
      .slice()
      .sort((left, right) => numericTs(right.ts) - numericTs(left.ts))[0] as RecentToolErrorRow;
  }
  if (candidate.last_tool_error) {
    return { message: candidate.last_tool_error };
  }
  return null;
}

function recentToolErrors(storage: RescueStorage, session_id: string): RecentToolErrorRow[] {
  if (typeof storage.recentToolErrors !== 'function') return [];
  const reader = storage.recentToolErrors as (...args: unknown[]) => unknown;

  try {
    const objectRows = reader.call(storage, { session_id, limit: 5 });
    if (Array.isArray(objectRows) && objectRows.length > 0) {
      return objectRows.filter(isRecentToolError);
    }
  } catch {
    // Older storage signatures are handled below.
  }

  try {
    const positionalRows = reader.call(storage, session_id, 5);
    if (Array.isArray(positionalRows)) {
      return positionalRows.filter(isRecentToolError);
    }
  } catch {
    return [];
  }

  return [];
}

function rescueOneLine(store: MemoryStore, session_id: string): string {
  const recent = store.storage.timeline(session_id, undefined, 20);
  const row = recent.find((entry) => !isErrorObservation(entry));
  if (!row) return 'Stranded session - no recent activity, claims held';
  const [expanded] = store.getObservations([row.id], { expand: true });
  return truncateOneLine(expanded?.content ?? row.content);
}

function isErrorObservation(row: ObservationRow): boolean {
  const kind = row.kind.toLowerCase();
  return (
    kind.includes('error') ||
    kind === 'observer-note' ||
    kind === 'rescue-relay' ||
    kind === 'relay'
  );
}

function lastObservationTs(
  store: MemoryStore,
  session_id: string,
  candidate: StrandedSessionRow,
): number | null {
  const candidateTs = numericTs(candidate.last_observation_ts);
  if (candidateTs > 0) return candidateTs;
  return store.storage.timeline(session_id, undefined, 1)[0]?.ts ?? null;
}

function relayReasonFor(error: RecentToolErrorRow | null): RelayReason {
  return quotaText(error) ? 'quota' : 'unspecified';
}

function rescueReasonFor(error: RecentToolErrorRow | null): string {
  if (!error) return 'silent-stranded';
  if (quotaText(error)) return 'quota-rejection';
  return `last-error: ${toolName(error)}`;
}

function quotaText(error: RecentToolErrorRow | null): boolean {
  return error ? /quota/i.test(renderToolError(error) ?? '') : false;
}

function renderToolError(error: RecentToolErrorRow | null): string | null {
  if (!error) return null;
  const text = [toolName(error), error.message, error.error, error.content]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(': ');
  return text || null;
}

function toolName(error: RecentToolErrorRow): string {
  return error.tool ?? error.tool_name ?? error.name ?? 'unknown';
}

function isRecentToolError(value: unknown): value is RecentToolErrorRow {
  return Boolean(value && typeof value === 'object');
}

function inferAgent(session_id: string): string {
  const ide = inferIdeFromSessionId(session_id);
  if (ide === 'claude-code') return 'claude';
  if (ide) return ide;
  const parts = session_id.split(/[@\-:/_]/).filter(Boolean);
  if (parts[0] === 'agent' && parts[1]) return parts[1];
  return parts[0] ?? 'unknown';
}

function baseBranchFor(task: TaskRow | undefined): string {
  const branch = task?.branch.trim();
  if (!branch) return 'main';
  if (branch === 'main' || branch === 'master' || branch === 'dev') return branch;
  return 'main';
}

function truncateOneLine(input: string): string {
  const singleLine = input.replace(/\s+/g, ' ').trim();
  return singleLine.length > ONE_LINE_LIMIT ? singleLine.slice(0, ONE_LINE_LIMIT) : singleLine;
}

function normalizePath(path: string | null | undefined): string | undefined {
  return typeof path === 'string' && path.trim() ? path : undefined;
}

function numericTs(value: number | string | null | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Date.parse(value) || 0;
  }
  return 0;
}
