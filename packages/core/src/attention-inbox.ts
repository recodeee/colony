import { resolve } from 'node:path';
import type {
  FileHeatRow,
  OmxRuntimeWarningRow,
  PausedLaneRow,
  TaskClaimRow,
  TaskRow,
} from '@colony/storage';
import { type ClaimAgeClass, type ClaimOwnershipStrength, classifyClaimAge } from './claim-age.js';
import {
  type HivemindActivity,
  type HivemindOptions,
  type HivemindSession,
  readHivemind,
} from './hivemind.js';
import {
  type LiveFileContentionWarning,
  liveFileContentionsForSessionClaims,
} from './live-file-contention.js';
import type { MemoryStore } from './memory-store.js';
import {
  type MessageActionSummary,
  type MessageSummary,
  listMessagesForAgent,
  withMessageActionHints,
} from './messages.js';
import {
  type HandoffMetadata,
  type HandoffTarget,
  TaskThread,
  type WakeRequestMetadata,
} from './task-thread.js';

/**
 * Pending handoff item reduced to the shape the inbox surfaces: id, sender,
 * one-line reason, expiry hint, task + accept-call hint. Full body stays in
 * the observation row — callers that want it fetch via get_observations.
 */
export interface InboxHandoff {
  id: number;
  task_id: number;
  from_agent: string;
  from_session_id: string;
  to_agent: HandoffTarget;
  to_session_id: string | null;
  summary: string;
  expires_at: number;
  handoff_ttl_ms?: number;
  ts: number;
  reason?: string;
  runtime_status?: string;
  priority?: 'high';
  suggested_next_step?: string;
}

export interface InboxWake {
  id: number;
  task_id: number;
  from_agent: string;
  from_session_id: string;
  reason: string;
  next_step: string;
  expires_at: number;
  ts: number;
}

export interface InboxMessageReplyArgs {
  task_id: number;
  session_id: string;
  agent: string;
  to_agent: 'any';
  to_session_id: string;
  reply_to: number;
  urgency: 'fyi';
  content: string;
}

export interface InboxMessageMarkReadArgs {
  message_observation_id: number;
  session_id: string;
}

export interface InboxMessage extends MessageActionSummary {
  reply_tool: 'task_message';
  mark_read_tool: 'task_message_mark_read';
  reply_with_tool: 'task_message';
  reply_with_args: InboxMessageReplyArgs;
  mark_read_with_tool: 'task_message_mark_read';
  mark_read_with_args: InboxMessageMarkReadArgs;
  /**
   * Present for `blocking` and `needs_reply` messages so compact inbox
   * renderers can show the expected action without hardcoding urgency
   * semantics. FYI messages keep only tool affordances.
   */
  next_action?: string;
}

export interface InboxLane {
  repo_root: string;
  branch: string;
  task: string;
  owner: string;
  activity: HivemindActivity;
  activity_summary: string;
  worktree_path: string;
  updated_at: string;
}

export interface InboxPausedLane {
  session_id: string;
  task_id: number | null;
  repo_root: string | null;
  branch: string | null;
  task: string | null;
  reason: string | null;
  paused_at: number;
  paused_by_session_id: string;
  cwd: string | null;
}

export interface InboxRecentClaim {
  task_id: number;
  file_path: string;
  by_session_id: string;
  claimed_at: number;
  age_minutes: number;
  age_class: ClaimAgeClass;
  ownership_strength: ClaimOwnershipStrength;
}

export interface InboxFileHeat {
  task_id: number;
  file_path: string;
  heat: number;
  last_activity_ts: number;
  event_count: number;
}

export interface InboxStaleClaimBranch {
  repo_root: string;
  branch: string;
  stale_claim_count: number;
  expired_weak_claim_count: number;
  oldest_claim_age_minutes: number;
  sweep_suggestion: string;
}

export interface InboxStaleClaimSignals {
  stale_claim_count: number;
  top_stale_branches: InboxStaleClaimBranch[];
  sweep_suggestion: string;
}

export interface InboxOmxRuntimeWarning {
  id: number;
  task_id: number | null;
  session_id: string;
  ts: number;
  warnings: string[];
  preview: string;
  active_file_focus: string[];
  next_action: string;
}

/**
 * Coalesced view: a group of inbox messages that share `(task_id,
 * from_session_id, urgency)`. Lets the preface render "B sent 4 fyi
 * messages on task #12, latest: …" instead of four near-identical lines.
 *
 * `blocking` urgency lands in groups of size 1 — every blocking message
 * stays its own row so no critical signal gets folded into a counter.
 * Single-message groups for non-blocking urgencies still ship as a group
 * (size 1) so consumers iterate one structure.
 */
export interface CoalescedMessageGroup {
  task_id: number;
  from_session_id: string;
  from_agent: string;
  urgency: MessageSummary['urgency'];
  count: number;
  message_ids: number[];
  latest_id: number;
  latest_ts: number;
  latest_preview: string;
}

/**
 * Read-receipt surfaced to the original sender. Built from sibling
 * `message_read` observations whose metadata names this session as the
 * `original_sender_session_id`. The "still-awaiting-reply" predicate is
 * computed against the read message's *current* status: if the recipient
 * has since replied, the receipt is dropped — the reply is the stronger
 * signal and the inbox shouldn't double-surface.
 */
export interface ReadReceipt {
  task_id: number;
  read_message_id: number;
  read_at: number;
  read_by_session_id: string;
  read_by_agent: string;
  urgency: MessageSummary['urgency'];
}

export interface AttentionInbox {
  generated_at: number;
  session_id: string;
  agent: string;
  summary: {
    pending_handoff_count: number;
    expired_quota_handoff_count: number;
    pending_wake_count: number;
    unread_message_count: number;
    paused_lane_count: number;
    stalled_lane_count: number;
    fresh_other_claim_count: number;
    stale_other_claim_count: number;
    expired_other_claim_count: number;
    weak_other_claim_count: number;
    recent_other_claim_count: number;
    live_file_contention_count: number;
    hot_file_count: number;
    omx_runtime_warning_count: number;
    /**
     * True iff at least one unread message is `urgency='blocking'`. The
     * preface renderer should use this to gate non-message sections —
     * advisory only at this layer (we still populate the other fields)
     * because a hard hide here would also hide the inbox surface that
     * lets consumers debug why they were blocked.
     */
    blocked: boolean;
    next_action: string;
  };
  pending_handoffs: InboxHandoff[];
  expired_quota_handoffs: InboxHandoff[];
  pending_wakes: InboxWake[];
  unread_messages: InboxMessage[];
  /** Same set of unread messages, grouped by (task, sender, urgency). */
  coalesced_messages: CoalescedMessageGroup[];
  /** `message_read` siblings for messages this session originally sent
   *  that have not been replied to. Sized by `read_receipt_window_ms`. */
  read_receipts: ReadReceipt[];
  paused_lanes: InboxPausedLane[];
  stalled_lanes: InboxLane[];
  stalled_lanes_truncated: boolean;
  stale_claim_signals: InboxStaleClaimSignals;
  recent_other_claims: InboxRecentClaim[];
  live_file_contentions: LiveFileContentionWarning[];
  file_heat: InboxFileHeat[];
  omx_runtime_warnings: InboxOmxRuntimeWarning[];
}

export interface AttentionInboxOptions {
  session_id: string;
  agent: string;
  repo_root?: string;
  repo_roots?: string[];
  now?: number;
  /**
   * Window (ms) for "recent other-session claim" surfacing. Default 15m —
   * longer than the 5m active-edit window the UserPromptSubmit conflict
   * preface uses, because the inbox is a review surface, not a live warning.
   */
  recent_claim_window_ms?: number;
  claim_stale_ms?: number;
  recent_claim_limit?: number;
  /** Tasks to scan for pending handoffs/wakes. Defaults to all tasks the
   *  session participates in. */
  task_ids?: number[];
  unread_message_limit?: number;
  /** Defaults true; hooks can disable filesystem hivemind reads for hot paths. */
  include_stalled_lanes?: boolean;
  /** Max stalled lane rows returned. Summary still reports the total count. */
  stalled_lane_limit?: number;
  /** Half-life for decaying file heat. Defaults 30m; MCP passes settings. */
  file_heat_half_life_ms?: number;
  file_heat_limit?: number;
  file_heat_min_heat?: number;
  omx_runtime_warning_limit?: number;
  /** Window (ms) for read-receipt surfacing. Receipts older than this drop
   *  out so a long-running session doesn't accumulate stale "B read your
   *  message 3 days ago" hints. Default 6h. */
  read_receipt_window_ms?: number;
  /**
   * Minimum age (ms) before a read receipt becomes surface-worthy. Receipts
   * younger than this are suppressed because "B read 30s ago, no reply yet"
   * is noise — B is still thinking. The receipt only carries signal once
   * "they had time to respond and didn't" is meaningful. Default 5m;
   * shorter windows make sense in tests, longer windows make sense for
   * heavyweight reviews where 5m is still too eager. Set to 0 to disable.
   */
  read_receipt_min_age_ms?: number;
  read_receipt_limit?: number;
}

const DEFAULT_RECENT_CLAIM_WINDOW_MS = 15 * 60_000;
const DEFAULT_RECENT_CLAIM_LIMIT = 20;
const DEFAULT_FILE_HEAT_HALF_LIFE_MS = 30 * 60_000;
const DEFAULT_FILE_HEAT_LIMIT = 10;
const DEFAULT_STALLED_LANE_LIMIT = 8;
const DEFAULT_STALE_CLAIM_BRANCH_LIMIT = 5;
const DEFAULT_READ_RECEIPT_WINDOW_MS = 6 * 60 * 60_000;
const DEFAULT_READ_RECEIPT_MIN_AGE_MS = 5 * 60_000;
const DEFAULT_READ_RECEIPT_LIMIT = 20;
const DEFAULT_OMX_RUNTIME_WARNING_LIMIT = 5;

/**
 * Aggregate "things that need this session's attention" across tasks and
 * hivemind lanes. Progressive disclosure: this is the compact shape. Full
 * observation bodies are fetched via get_observations by id.
 *
 * Scope intentionally narrow: pending handoffs, pending wakes, stalled
 * lanes, fresh other-session claims, and a compact stale-claim summary.
 * Items explicitly not here yet — "PRs open needing merge" (no GitHub
 * integration) and a cleanup apply path for stale claims — are deferred to
 * later PRs.
 */
export function buildAttentionInbox(
  store: MemoryStore,
  opts: AttentionInboxOptions,
): AttentionInbox {
  const now = opts.now ?? Date.now();
  const taskIds = resolveTaskIds(store, opts);

  const pending_handoffs: InboxHandoff[] = [];
  const expired_quota_handoffs: InboxHandoff[] = [];
  const pending_wakes: InboxWake[] = [];
  const scanned_other_claims: InboxRecentClaim[] = [];
  const unread_messages = listMessagesForAgent(store, {
    session_id: opts.session_id,
    agent: opts.agent,
    now,
    task_ids: taskIds,
    unread_only: true,
    ...(opts.unread_message_limit !== undefined ? { limit: opts.unread_message_limit } : {}),
  }).map((message) => withInboxMessageActions(message, opts));

  const recentWindow = opts.recent_claim_window_ms ?? DEFAULT_RECENT_CLAIM_WINDOW_MS;
  const recentLimit = opts.recent_claim_limit ?? DEFAULT_RECENT_CLAIM_LIMIT;
  const claimStaleMinutes =
    (opts.claim_stale_ms ?? store.settings.claimStaleMinutes * 60_000) / 60_000;
  const recentSince = now - recentWindow;

  for (const task_id of taskIds) {
    const thread = new TaskThread(store, task_id);
    for (const h of thread.pendingHandoffsFor(opts.session_id, opts.agent, now)) {
      pending_handoffs.push(compactHandoff(task_id, h.id, h.ts, h.meta));
    }
    for (const h of thread.expiredQuotaHandoffsFor(opts.session_id, opts.agent, now)) {
      expired_quota_handoffs.push(compactHandoff(task_id, h.id, h.ts, h.meta));
    }
    for (const w of thread.pendingWakesFor(opts.session_id, opts.agent)) {
      pending_wakes.push(compactWake(task_id, w.id, w.ts, w.meta));
    }
    for (const claim of store.storage.recentClaims(task_id, recentSince, recentLimit)) {
      if (claim.session_id === opts.session_id) continue;
      scanned_other_claims.push(
        compactClaim(claim, { now, claim_stale_minutes: claimStaleMinutes }),
      );
    }
  }
  pending_handoffs.sort(compareHandoffPriority);
  expired_quota_handoffs.sort((a, b) => b.ts - a.ts);

  const recent_other_claims = scanned_other_claims.filter((claim) => claim.age_class === 'fresh');
  const live_file_contentions = liveFileContentionsForSessionClaims(store, {
    session_id: opts.session_id,
    task_ids: taskIds,
    ...(opts.repo_root !== undefined ? { repo_root: opts.repo_root } : {}),
    ...(opts.repo_roots !== undefined ? { repo_roots: opts.repo_roots } : {}),
    now,
    claim_stale_minutes: claimStaleMinutes,
    assume_requester_live: true,
  });
  const stale_claim_signals = collectStaleClaimSignals(store, opts, taskIds, {
    now,
    claim_stale_minutes: claimStaleMinutes,
  });
  const stalledLaneResult =
    opts.include_stalled_lanes === false ? emptyStalledLaneResult() : collectStalledLanes(opts);
  const stalled_lanes = stalledLaneResult.rows;
  const paused_lanes = collectPausedLanes(store, opts);
  const file_heat = collectFileHeat(store, opts, taskIds, now);
  const omx_runtime_warnings = collectOmxRuntimeWarnings(store, opts, taskIds, now);

  const read_receipts = collectReadReceipts(store, opts, taskIds, now);
  const coalesced_messages = coalesceMessages(unread_messages);
  const blocked = unread_messages.some((m) => m.urgency === 'blocking');
  const staleClaims = scanned_other_claims.filter((claim) => claim.age_class === 'stale');
  const expiredClaims = scanned_other_claims.filter((claim) => claim.age_class === 'expired/weak');
  const weakClaims = scanned_other_claims.filter((claim) => claim.ownership_strength === 'weak');

  const summary = {
    pending_handoff_count: pending_handoffs.length,
    expired_quota_handoff_count: expired_quota_handoffs.length,
    pending_wake_count: pending_wakes.length,
    unread_message_count: unread_messages.length,
    paused_lane_count: paused_lanes.length,
    stalled_lane_count: stalledLaneResult.total,
    fresh_other_claim_count: recent_other_claims.length,
    stale_other_claim_count: staleClaims.length,
    expired_other_claim_count: expiredClaims.length,
    weak_other_claim_count: weakClaims.length,
    recent_other_claim_count: recent_other_claims.length,
    live_file_contention_count: live_file_contentions.length,
    hot_file_count: file_heat.length,
    omx_runtime_warning_count: omx_runtime_warnings.length,
    blocked,
    next_action: deriveNextAction({
      pending_handoffs,
      expired_quota_handoffs,
      pending_wakes,
      unread_messages,
      paused_lanes,
      stalled_lanes,
      stale_claim_signals,
      recent_other_claims,
      live_file_contentions,
      file_heat,
      read_receipts,
      omx_runtime_warnings,
    }),
  };

  return {
    generated_at: now,
    session_id: opts.session_id,
    agent: opts.agent,
    summary,
    pending_handoffs,
    expired_quota_handoffs,
    pending_wakes,
    unread_messages,
    coalesced_messages,
    read_receipts,
    paused_lanes,
    stalled_lanes,
    stalled_lanes_truncated: stalledLaneResult.truncated,
    stale_claim_signals,
    recent_other_claims,
    live_file_contentions,
    file_heat,
    omx_runtime_warnings,
  };
}

/**
 * Group unread messages by `(task_id, from_session_id, urgency)`. Blocking
 * urgency never coalesces: every blocking message remains a singleton group
 * so compact renderers cannot fold an active blocker into a counter.
 */
function coalesceMessages(messages: InboxMessage[]): CoalescedMessageGroup[] {
  const groups = new Map<string, InboxMessage[]>();
  const out: CoalescedMessageGroup[] = [];
  for (const m of messages) {
    if (m.urgency === 'blocking') {
      out.push(messageGroupFromBucket([m]));
      continue;
    }
    const key = JSON.stringify([m.task_id, m.from_session_id, m.urgency]);
    const bucket = groups.get(key);
    if (bucket) bucket.push(m);
    else groups.set(key, [m]);
  }
  for (const bucket of groups.values()) {
    out.push(messageGroupFromBucket(bucket));
  }
  // Newest group first, matching unread_messages ordering.
  return out.sort((a, b) => b.latest_ts - a.latest_ts);
}

function messageGroupFromBucket(bucket: InboxMessage[]): CoalescedMessageGroup {
  bucket.sort((a, b) => a.ts - b.ts);
  const latest = bucket[bucket.length - 1];
  if (!latest) throw new Error('message coalescing received an empty bucket');
  return {
    task_id: latest.task_id,
    from_session_id: latest.from_session_id,
    from_agent: latest.from_agent,
    urgency: latest.urgency,
    count: bucket.length,
    message_ids: bucket.map((m) => m.id),
    latest_id: latest.id,
    latest_ts: latest.ts,
    latest_preview: latest.preview,
  };
}

/**
 * Walk task observation rows of kind 'message_read' and surface the ones
 * whose metadata names the calling session as the original sender. Drops
 * a receipt when the underlying message has since been replied to (the
 * reply is the stronger signal), when the receipt is older than
 * `read_receipt_window_ms`, or when the receipt is *younger* than
 * `read_receipt_min_age_ms`. The min-age filter prevents the noisy
 * "B read 30s ago, no reply yet" case where the recipient is still
 * formulating a response — the receipt only carries signal once enough
 * time has passed that "could have replied and didn't" is honest.
 */
function collectReadReceipts(
  store: MemoryStore,
  opts: AttentionInboxOptions,
  taskIds: number[],
  now: number,
): ReadReceipt[] {
  const window = opts.read_receipt_window_ms ?? DEFAULT_READ_RECEIPT_WINDOW_MS;
  const minAge = opts.read_receipt_min_age_ms ?? DEFAULT_READ_RECEIPT_MIN_AGE_MS;
  const cap = opts.read_receipt_limit ?? DEFAULT_READ_RECEIPT_LIMIT;
  const since = now - window;
  const ripeBefore = now - minAge;
  const out: ReadReceipt[] = [];
  for (const task_id of taskIds) {
    const rows = store.storage.taskObservationsByKind(task_id, 'message_read', cap * 2);
    for (const r of rows) {
      if (r.ts < since) continue;
      if (!r.metadata) continue;
      let meta: {
        kind?: string;
        original_sender_session_id?: string;
        read_message_id?: number;
        read_by_session_id?: string;
        read_by_agent?: string;
        urgency?: MessageSummary['urgency'];
        ts?: number;
      };
      try {
        meta = JSON.parse(r.metadata);
      } catch {
        continue;
      }
      if (meta.kind !== 'message_read') continue;
      if (meta.original_sender_session_id !== opts.session_id) continue;
      if (typeof meta.read_message_id !== 'number') continue;
      const readAt = typeof meta.ts === 'number' ? meta.ts : r.ts;
      // Min-age gate: the receipt is real but too fresh to act on.
      // Recipient might still be typing; surfacing now turns every
      // mark_read into a "follow up?" prompt for the sender.
      if (readAt > ripeBefore) continue;
      // Drop when the original message has since been replied to. The
      // reply already reaches the sender as a fresh inbox entry, so a
      // surviving receipt would be redundant noise.
      const messageRow = store.storage.getObservation(meta.read_message_id);
      if (!messageRow || messageRow.kind !== 'message') continue;
      try {
        const messageMeta = JSON.parse(messageRow.metadata ?? '{}') as { status?: string };
        if (messageMeta.status === 'replied') continue;
      } catch {
        continue;
      }
      out.push({
        task_id,
        read_message_id: meta.read_message_id,
        read_at: readAt,
        read_by_session_id: meta.read_by_session_id ?? r.session_id,
        read_by_agent: meta.read_by_agent ?? '',
        urgency: meta.urgency ?? 'fyi',
      });
    }
  }
  return out.sort((a, b) => b.read_at - a.read_at).slice(0, cap);
}

function collectOmxRuntimeWarnings(
  store: MemoryStore,
  opts: AttentionInboxOptions,
  taskIds: number[],
  now: number,
): InboxOmxRuntimeWarning[] {
  const cap = opts.omx_runtime_warning_limit ?? DEFAULT_OMX_RUNTIME_WARNING_LIMIT;
  if (cap <= 0) return [];
  const since = now - DEFAULT_READ_RECEIPT_WINDOW_MS;
  const taskIdSet = new Set(taskIds);
  return store.storage
    .omxRuntimeWarningsSince(since, cap * 4)
    .filter((row) => row.task_id === null || taskIdSet.size === 0 || taskIdSet.has(row.task_id))
    .slice(0, cap)
    .map(compactOmxRuntimeWarning);
}

function compactOmxRuntimeWarning(row: OmxRuntimeWarningRow): InboxOmxRuntimeWarning {
  return {
    id: row.id,
    task_id: row.task_id,
    session_id: row.session_id,
    ts: row.ts,
    warnings: row.warnings,
    preview: row.content.slice(0, 240),
    active_file_focus: row.active_file_focus,
    next_action: 'Review OMX runtime warning before resuming this lane; Colony remains coordination truth.',
  };
}

function resolveTaskIds(store: MemoryStore, opts: AttentionInboxOptions): number[] {
  if (opts.task_ids && opts.task_ids.length > 0) {
    return [...new Set(opts.task_ids)];
  }
  // All tasks the session is currently participating in. Broader than
  // findActiveTaskForSession (which returns one id); the inbox wants every
  // lane the session could hear from.
  const rows = store.storage.listTasks(200);
  const repoRoots = attentionRepoRoots(opts);
  const participating: number[] = [];
  for (const task of rows) {
    if (repoRoots.size > 0 && !repoRoots.has(resolve(task.repo_root))) continue;
    const agent = store.storage.getParticipantAgent(task.id, opts.session_id);
    if (agent !== undefined) participating.push(task.id);
  }
  return participating;
}

function attentionRepoRoots(opts: AttentionInboxOptions): Set<string> {
  return new Set(
    [opts.repo_root, ...(opts.repo_roots ?? [])]
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter(Boolean)
      .map((entry) => resolve(entry)),
  );
}

function compactHandoff(
  task_id: number,
  id: number,
  ts: number,
  meta: HandoffMetadata,
): InboxHandoff {
  const out: InboxHandoff = {
    id,
    task_id,
    from_agent: meta.from_agent,
    from_session_id: meta.from_session_id,
    to_agent: meta.to_agent,
    to_session_id: meta.to_session_id,
    summary: meta.summary,
    expires_at: meta.expires_at,
    handoff_ttl_ms: meta.handoff_ttl_ms,
    ts,
  };
  if (meta.reason !== undefined) out.reason = meta.reason;
  if (meta.runtime_status !== undefined) out.runtime_status = meta.runtime_status;
  if (meta.reason === 'quota_exhausted') {
    out.priority = 'high';
    const suggestedNextStep = meta.quota_context?.suggested_next_step ?? meta.next_steps[0];
    if (suggestedNextStep !== undefined) out.suggested_next_step = suggestedNextStep;
  }
  return out;
}

function compactWake(
  task_id: number,
  id: number,
  ts: number,
  meta: WakeRequestMetadata,
): InboxWake {
  return {
    id,
    task_id,
    from_agent: meta.from_agent,
    from_session_id: meta.from_session_id,
    reason: meta.reason,
    next_step: meta.next_step,
    expires_at: meta.expires_at,
    ts,
  };
}

function withInboxMessageActions(
  message: MessageSummary,
  opts: Pick<AttentionInboxOptions, 'session_id' | 'agent'>,
): InboxMessage {
  const actionHints = withMessageActionHints(message, opts);
  const base = {
    ...actionHints,
    reply_with_tool: actionHints.reply_tool,
    reply_with_args: actionHints.reply_args,
    mark_read_with_tool: actionHints.mark_read_tool,
    mark_read_with_args: actionHints.mark_read_args,
  };
  return base;
}

function compactClaim(
  row: TaskClaimRow,
  options: { now: number; claim_stale_minutes: number },
): InboxRecentClaim {
  const classification = classifyClaimAge(row, options);
  return {
    task_id: row.task_id,
    file_path: row.file_path,
    by_session_id: row.session_id,
    claimed_at: row.claimed_at,
    age_minutes: classification.age_minutes,
    age_class: classification.age_class,
    ownership_strength: classification.ownership_strength,
  };
}

function collectStaleClaimSignals(
  store: MemoryStore,
  opts: AttentionInboxOptions,
  taskIds: number[],
  options: { now: number; claim_stale_minutes: number },
): InboxStaleClaimSignals {
  const byBranch = new Map<string, InboxStaleClaimBranch>();
  let staleClaimCount = 0;
  let expiredWeakClaimCount = 0;

  let tasks: TaskRow[];
  try {
    tasks = staleClaimTasks(store, opts, taskIds);
  } catch {
    return emptyStaleClaimSignals();
  }

  for (const task of tasks) {
    let claims: TaskClaimRow[];
    try {
      claims = store.storage.listClaims(task.id);
    } catch {
      continue;
    }

    for (const claim of claims) {
      const classification = classifyClaimAge(claim, options);
      if (classification.ownership_strength === 'strong') continue;

      staleClaimCount += 1;
      const key = `${task.repo_root}\u0000${task.branch}`;
      const branch =
        byBranch.get(key) ??
        ({
          repo_root: task.repo_root,
          branch: task.branch,
          stale_claim_count: 0,
          expired_weak_claim_count: 0,
          oldest_claim_age_minutes: 0,
          sweep_suggestion: '',
        } satisfies InboxStaleClaimBranch);

      branch.stale_claim_count += 1;
      if (classification.age_class === 'expired/weak') {
        branch.expired_weak_claim_count += 1;
        expiredWeakClaimCount += 1;
      }
      branch.oldest_claim_age_minutes = Math.max(
        branch.oldest_claim_age_minutes,
        classification.age_minutes,
      );
      branch.sweep_suggestion =
        branch.expired_weak_claim_count > 0
          ? `review ${branch.expired_weak_claim_count} expired/weak advisory claim(s) before release; keep audit history`
          : `review ${branch.stale_claim_count} stale advisory claim(s) before release or handoff`;
      byBranch.set(key, branch);
    }
  }

  const top_stale_branches = [...byBranch.values()]
    .sort(
      (a, b) =>
        b.stale_claim_count - a.stale_claim_count ||
        b.expired_weak_claim_count - a.expired_weak_claim_count ||
        b.oldest_claim_age_minutes - a.oldest_claim_age_minutes ||
        a.branch.localeCompare(b.branch),
    )
    .slice(0, DEFAULT_STALE_CLAIM_BRANCH_LIMIT);

  return {
    stale_claim_count: staleClaimCount,
    top_stale_branches,
    sweep_suggestion: staleClaimSweepSuggestion(staleClaimCount, expiredWeakClaimCount),
  };
}

function emptyStaleClaimSignals(): InboxStaleClaimSignals {
  return {
    stale_claim_count: 0,
    top_stale_branches: [],
    sweep_suggestion: staleClaimSweepSuggestion(0, 0),
  };
}

function staleClaimTasks(
  store: MemoryStore,
  opts: AttentionInboxOptions,
  taskIds: number[],
): TaskRow[] {
  const explicitTaskIds = new Set(opts.task_ids ?? []);
  const repoRoots = attentionRepoRoots(opts);
  const participatingTaskIds = new Set(taskIds);

  return store.storage.listTasks(2_000).filter((task) => {
    if (explicitTaskIds.size > 0) return explicitTaskIds.has(task.id);
    if (repoRoots.size > 0) return repoRoots.has(resolve(task.repo_root));
    return participatingTaskIds.has(task.id);
  });
}

function staleClaimSweepSuggestion(staleClaimCount: number, expiredWeakClaimCount: number): string {
  if (staleClaimCount === 0) return 'no sweep needed; no stale advisory claims found';
  if (expiredWeakClaimCount > 0) {
    return `run coordination sweep dry-run; review ${staleClaimCount} stale advisory claim(s), including ${expiredWeakClaimCount} expired/weak claim(s); keep audit history`;
  }
  return `run coordination sweep dry-run; review ${staleClaimCount} stale advisory claim(s) before release or handoff`;
}

function collectFileHeat(
  store: MemoryStore,
  opts: AttentionInboxOptions,
  taskIds: number[],
  now: number,
): InboxFileHeat[] {
  if (taskIds.length === 0) return [];
  const halfLifeMs = opts.file_heat_half_life_ms ?? DEFAULT_FILE_HEAT_HALF_LIFE_MS;
  const rows = store.storage.fileHeat({
    task_ids: taskIds,
    now,
    half_life_minutes: halfLifeMs / 60_000,
    ...(opts.file_heat_limit !== undefined ? { limit: opts.file_heat_limit } : {}),
    ...(opts.file_heat_min_heat !== undefined ? { min_heat: opts.file_heat_min_heat } : {}),
  });
  return rows.slice(0, opts.file_heat_limit ?? DEFAULT_FILE_HEAT_LIMIT).map(compactFileHeat);
}

function compactFileHeat(row: FileHeatRow): InboxFileHeat {
  return {
    task_id: row.task_id,
    file_path: row.file_path,
    heat: Number(row.heat.toFixed(3)),
    last_activity_ts: row.last_activity_ts,
    event_count: row.event_count,
  };
}

function collectPausedLanes(store: MemoryStore, opts: AttentionInboxOptions): InboxPausedLane[] {
  const repoRoots = attentionRepoRoots(opts);
  return store.storage
    .listPausedLanes(100)
    .filter((lane) => pausedLaneMatchesRepo(lane, repoRoots))
    .map(compactPausedLane);
}

function pausedLaneMatchesRepo(lane: PausedLaneRow, repoRoots: Set<string>): boolean {
  if (repoRoots.size === 0) return true;
  if (!lane.repo_root) return true;
  return repoRoots.has(resolve(lane.repo_root));
}

function compactPausedLane(row: PausedLaneRow): InboxPausedLane {
  return {
    session_id: row.session_id,
    task_id: row.task_id,
    repo_root: row.repo_root,
    branch: row.branch,
    task: row.task_title,
    reason: row.reason,
    paused_at: row.updated_at,
    paused_by_session_id: row.updated_by_session_id,
    cwd: row.cwd,
  };
}

function collectStalledLanes(opts: AttentionInboxOptions): {
  rows: InboxLane[];
  total: number;
  truncated: boolean;
} {
  const options: HivemindOptions = { includeStale: true };
  if (opts.repo_root !== undefined) options.repoRoot = opts.repo_root;
  if (opts.repo_roots !== undefined) options.repoRoots = opts.repo_roots;
  if (opts.now !== undefined) options.now = opts.now;
  const limit = normalizeStalledLaneLimit(opts.stalled_lane_limit);

  try {
    const snapshot = readHivemind(options);
    const rows = snapshot.sessions.filter(isLaneStalled).map(toInboxLane);
    return { rows: rows.slice(0, limit), total: rows.length, truncated: rows.length > limit };
  } catch {
    // Best effort — hivemind read touches the filesystem and must never
    // turn an inbox query into a fatal error.
    return emptyStalledLaneResult();
  }
}

function emptyStalledLaneResult(): { rows: InboxLane[]; total: number; truncated: boolean } {
  return { rows: [], total: 0, truncated: false };
}

function normalizeStalledLaneLimit(limit: number | undefined): number {
  if (!Number.isInteger(limit) || limit === undefined) return DEFAULT_STALLED_LANE_LIMIT;
  return Math.max(0, Math.min(limit, 100));
}

function isLaneStalled(session: HivemindSession): boolean {
  return session.activity === 'stalled' || session.activity === 'dead';
}

function toInboxLane(session: HivemindSession): InboxLane {
  return {
    repo_root: session.repo_root,
    branch: session.branch,
    task: session.task,
    owner: `${session.agent}/${session.cli}`,
    activity: session.activity,
    activity_summary: session.activity_summary,
    worktree_path: session.worktree_path,
    updated_at: session.updated_at,
  };
}

function deriveNextAction(parts: {
  pending_handoffs: InboxHandoff[];
  expired_quota_handoffs: InboxHandoff[];
  pending_wakes: InboxWake[];
  unread_messages: InboxMessage[];
  paused_lanes: InboxPausedLane[];
  stalled_lanes: InboxLane[];
  stale_claim_signals: InboxStaleClaimSignals;
  recent_other_claims: InboxRecentClaim[];
  live_file_contentions: LiveFileContentionWarning[];
  file_heat: InboxFileHeat[];
  read_receipts: ReadReceipt[];
  omx_runtime_warnings: InboxOmxRuntimeWarning[];
}): string {
  if (parts.pending_handoffs.some((h) => h.reason === 'quota_exhausted')) {
    return 'Accept active quota_exhausted handoff first; sender is blocked_by_runtime_limit.';
  }
  if (parts.unread_messages.some((m) => m.urgency === 'blocking')) {
    return 'Answer blocking task messages first; another agent is explicitly blocked on you.';
  }
  if (parts.pending_handoffs.length > 0) {
    return 'Respond to pending handoffs first; each baton pass is blocking until accept or decline.';
  }
  if (parts.unread_messages.some((m) => m.urgency === 'needs_reply')) {
    return 'Reply to task messages that need a response before starting unrelated work.';
  }
  if (parts.pending_wakes.length > 0) {
    return 'Acknowledge pending wake requests; another session is waiting on you.';
  }
  if (parts.expired_quota_handoffs.length > 0) {
    return 'Review expired quota_exhausted handoffs as stale resume context; do not treat them as live baton passes.';
  }
  if (parts.unread_messages.length > 0) {
    return 'Review unread FYI task messages when context allows.';
  }
  if (parts.read_receipts.some((r) => r.urgency !== 'fyi')) {
    return 'Recipients have read your needs_reply messages without responding — consider following up.';
  }
  if (parts.live_file_contentions.length > 0) {
    return 'LIVE_FILE_CONTENTION: another live agent owns a file you claimed; coordinate before editing.';
  }
  if (parts.omx_runtime_warnings.length > 0) {
    return 'Review OMX runtime warnings before resuming; quota, model, or failed-tool state may affect recovery.';
  }
  if (parts.paused_lanes.length > 0) {
    return 'Review paused lanes — resume them or request takeover for contended files.';
  }
  if (parts.stalled_lanes.length > 0) {
    return 'Review stalled lanes — takeover may be safer than waiting for the owner to return.';
  }
  if (parts.stale_claim_signals.stale_claim_count > 0) {
    return 'Review stale claim cleanup signal before treating old ownership as active.';
  }
  if (parts.recent_other_claims.length > 0) {
    return 'Other sessions have recent file claims nearby; coordinate before editing the same files.';
  }
  return 'Inbox is quiet; no immediate attention items.';
}

function compareHandoffPriority(a: InboxHandoff, b: InboxHandoff): number {
  const priorityDelta = handoffPriority(b) - handoffPriority(a);
  return priorityDelta === 0 ? b.ts - a.ts : priorityDelta;
}

function handoffPriority(handoff: InboxHandoff): number {
  return handoff.reason === 'quota_exhausted' ? 1 : 0;
}
