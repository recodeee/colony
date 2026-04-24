import type { TaskClaimRow } from '@colony/storage';
import {
  type HivemindActivity,
  type HivemindOptions,
  type HivemindSession,
  readHivemind,
} from './hivemind.js';
import type { MemoryStore } from './memory-store.js';
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

export interface AttentionInbox {
  generated_at: number;
  session_id: string;
  agent: string;
  summary: {
    pending_handoff_count: number;
    pending_wake_count: number;
    stalled_lane_count: number;
    recent_other_claim_count: number;
    next_action: string;
  };
  pending_handoffs: InboxHandoff[];
  pending_wakes: InboxWake[];
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
}

const DEFAULT_RECENT_CLAIM_WINDOW_MS = 15 * 60_000;
const DEFAULT_RECENT_CLAIM_LIMIT = 20;

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

  const stalled_lanes = collectStalledLanes(opts);

  const summary = {
    pending_handoff_count: pending_handoffs.length,
    pending_wake_count: pending_wakes.length,
    stalled_lane_count: stalled_lanes.length,
    recent_other_claim_count: recent_other_claims.length,
    next_action: deriveNextAction({
      pending_handoffs,
      pending_wakes,
      stalled_lanes,
      recent_other_claims,
    }),
  };

  return {
    generated_at: now,
    session_id: opts.session_id,
    agent: opts.agent,
    summary,
    pending_handoffs,
    pending_wakes,
    stalled_lanes,
    recent_other_claims,
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
  stalled_lanes: InboxLane[];
  recent_other_claims: InboxRecentClaim[];
}): string {
  if (parts.pending_handoffs.length > 0) {
    return 'Respond to pending handoffs first; each baton pass is blocking until accept or decline.';
  }
  if (parts.pending_wakes.length > 0) {
    return 'Acknowledge pending wake requests; another session is waiting on you.';
  }
  if (parts.stalled_lanes.length > 0) {
    return 'Review stalled lanes — takeover may be safer than waiting for the owner to return.';
  }
  if (parts.recent_other_claims.length > 0) {
    return 'Other sessions have recent file claims nearby; coordinate before editing the same files.';
  }
  return 'Inbox is quiet; no immediate attention items.';
}
