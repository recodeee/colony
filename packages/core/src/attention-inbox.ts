import type { TaskClaimRow } from '@colony/storage';
import {
  type HivemindActivity,
  type HivemindOptions,
  type HivemindSession,
  readHivemind,
} from './hivemind.js';
import type { MemoryStore } from './memory-store.js';
import { type MessageSummary, listMessagesForAgent } from './messages.js';
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
  ts: number;
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

export type InboxMessage = MessageSummary;

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

export interface InboxRecentClaim {
  task_id: number;
  file_path: string;
  by_session_id: string;
  claimed_at: number;
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
    pending_wake_count: number;
    unread_message_count: number;
    stalled_lane_count: number;
    recent_other_claim_count: number;
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
  pending_wakes: InboxWake[];
  unread_messages: InboxMessage[];
  /** Same set of unread messages, grouped by (task, sender, urgency). */
  coalesced_messages: CoalescedMessageGroup[];
  /** `message_read` siblings for messages this session originally sent
   *  that have not been replied to. Sized by `read_receipt_window_ms`. */
  read_receipts: ReadReceipt[];
  stalled_lanes: InboxLane[];
  recent_other_claims: InboxRecentClaim[];
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
  recent_claim_limit?: number;
  /** Tasks to scan for pending handoffs/wakes. Defaults to all tasks the
   *  session participates in. */
  task_ids?: number[];
  unread_message_limit?: number;
  /** Defaults true; hooks can disable filesystem hivemind reads for hot paths. */
  include_stalled_lanes?: boolean;
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
const DEFAULT_READ_RECEIPT_WINDOW_MS = 6 * 60 * 60_000;
const DEFAULT_READ_RECEIPT_MIN_AGE_MS = 5 * 60_000;
const DEFAULT_READ_RECEIPT_LIMIT = 20;

/**
 * Aggregate "things that need this session's attention" across tasks and
 * hivemind lanes. Progressive disclosure: this is the compact shape. Full
 * observation bodies are fetched via get_observations by id.
 *
 * Scope intentionally narrow: pending handoffs, pending wakes, stalled
 * lanes, other-session recent claims. Items explicitly not here yet —
 * "PRs open needing merge" (no GitHub integration) and "stale lock > TTL"
 * (claim TTL renewal is a separate follow-up) — are deferred to later PRs.
 */
export function buildAttentionInbox(
  store: MemoryStore,
  opts: AttentionInboxOptions,
): AttentionInbox {
  const now = opts.now ?? Date.now();
  const taskIds = resolveTaskIds(store, opts);

  const pending_handoffs: InboxHandoff[] = [];
  const pending_wakes: InboxWake[] = [];
  const recent_other_claims: InboxRecentClaim[] = [];
  const unread_messages = listMessagesForAgent(store, {
    session_id: opts.session_id,
    agent: opts.agent,
    now,
    task_ids: taskIds,
    unread_only: true,
    ...(opts.unread_message_limit !== undefined ? { limit: opts.unread_message_limit } : {}),
  });

  const recentWindow = opts.recent_claim_window_ms ?? DEFAULT_RECENT_CLAIM_WINDOW_MS;
  const recentLimit = opts.recent_claim_limit ?? DEFAULT_RECENT_CLAIM_LIMIT;
  const recentSince = now - recentWindow;

  for (const task_id of taskIds) {
    const thread = new TaskThread(store, task_id);
    for (const h of thread.pendingHandoffsFor(opts.session_id, opts.agent)) {
      pending_handoffs.push(compactHandoff(task_id, h.id, h.ts, h.meta));
    }
    for (const w of thread.pendingWakesFor(opts.session_id, opts.agent)) {
      pending_wakes.push(compactWake(task_id, w.id, w.ts, w.meta));
    }
    for (const claim of store.storage.recentClaims(task_id, recentSince, recentLimit)) {
      if (claim.session_id === opts.session_id) continue;
      recent_other_claims.push(compactClaim(claim));
    }
  }

  const stalled_lanes = opts.include_stalled_lanes === false ? [] : collectStalledLanes(opts);

  const read_receipts = collectReadReceipts(store, opts, taskIds, now);
  const coalesced_messages = coalesceMessages(unread_messages);
  const blocked = unread_messages.some((m) => m.urgency === 'blocking');

  const summary = {
    pending_handoff_count: pending_handoffs.length,
    pending_wake_count: pending_wakes.length,
    unread_message_count: unread_messages.length,
    stalled_lane_count: stalled_lanes.length,
    recent_other_claim_count: recent_other_claims.length,
    blocked,
    next_action: deriveNextAction({
      pending_handoffs,
      pending_wakes,
      unread_messages,
      stalled_lanes,
      recent_other_claims,
      read_receipts,
    }),
  };

  return {
    generated_at: now,
    session_id: opts.session_id,
    agent: opts.agent,
    summary,
    pending_handoffs,
    pending_wakes,
    unread_messages,
    coalesced_messages,
    read_receipts,
    stalled_lanes,
    recent_other_claims,
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

function resolveTaskIds(store: MemoryStore, opts: AttentionInboxOptions): number[] {
  if (opts.task_ids && opts.task_ids.length > 0) {
    return [...new Set(opts.task_ids)];
  }
  // All tasks the session is currently participating in. Broader than
  // findActiveTaskForSession (which returns one id); the inbox wants every
  // lane the session could hear from.
  const rows = store.storage.listTasks(200);
  const participating: number[] = [];
  for (const task of rows) {
    const agent = store.storage.getParticipantAgent(task.id, opts.session_id);
    if (agent !== undefined) participating.push(task.id);
  }
  return participating;
}

function compactHandoff(
  task_id: number,
  id: number,
  ts: number,
  meta: HandoffMetadata,
): InboxHandoff {
  return {
    id,
    task_id,
    from_agent: meta.from_agent,
    from_session_id: meta.from_session_id,
    to_agent: meta.to_agent,
    to_session_id: meta.to_session_id,
    summary: meta.summary,
    expires_at: meta.expires_at,
    ts,
  };
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

function compactClaim(row: TaskClaimRow): InboxRecentClaim {
  return {
    task_id: row.task_id,
    file_path: row.file_path,
    by_session_id: row.session_id,
    claimed_at: row.claimed_at,
  };
}

function collectStalledLanes(opts: AttentionInboxOptions): InboxLane[] {
  const options: HivemindOptions = { includeStale: true };
  if (opts.repo_root !== undefined) options.repoRoot = opts.repo_root;
  if (opts.repo_roots !== undefined) options.repoRoots = opts.repo_roots;
  if (opts.now !== undefined) options.now = opts.now;

  try {
    const snapshot = readHivemind(options);
    return snapshot.sessions.filter(isLaneStalled).map(toInboxLane);
  } catch {
    // Best effort — hivemind read touches the filesystem and must never
    // turn an inbox query into a fatal error.
    return [];
  }
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
  pending_wakes: InboxWake[];
  unread_messages: InboxMessage[];
  stalled_lanes: InboxLane[];
  recent_other_claims: InboxRecentClaim[];
  read_receipts: ReadReceipt[];
}): string {
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
  if (parts.unread_messages.length > 0) {
    return 'Review unread FYI task messages when context allows.';
  }
  if (parts.read_receipts.some((r) => r.urgency !== 'fyi')) {
    return 'Recipients have read your needs_reply messages without responding — consider following up.';
  }
  if (parts.stalled_lanes.length > 0) {
    return 'Review stalled lanes — takeover may be safer than waiting for the owner to return.';
  }
  if (parts.recent_other_claims.length > 0) {
    return 'Other sessions have recent file claims nearby; coordinate before editing the same files.';
  }
  return 'Inbox is quiet; no immediate attention items.';
}
