import type { MemoryStore } from './memory-store.js';
import type { MessageStatus, MessageTarget, MessageUrgency } from './task-thread.js';
import {
  isBroadcastMessage,
  isMessageAddressedTo,
  isVisibleToBroadcastClaimant,
  parseMessage,
} from './task-thread.js';

/**
 * Compact view of a directed message, safe to return from MCP list-shape
 * tools. The full body is still compressed in storage; callers that want it
 * expanded fetch via `get_observations`. Kept deliberately parallel to
 * `InboxHandoff` / `InboxWake` so a preface renderer can iterate all three
 * primitives with the same shape.
 */
export interface MessageSummary {
  id: number;
  task_id: number;
  ts: number;
  from_session_id: string;
  from_agent: string;
  to_agent: MessageTarget;
  to_session_id: string | null;
  urgency: MessageUrgency;
  status: MessageStatus;
  reply_to: number | null;
  preview: string;
  /** Absolute ms-epoch when this message stops surfacing in inbox queries.
   *  null when the message has no TTL. */
  expires_at: number | null;
  /** True when this is a `to_agent='any'` broadcast that has not yet been
   *  claimed; the inbox should hint that "first agent to engage owns it". */
  is_claimable_broadcast: boolean;
  claimed_by_session_id: string | null;
  claimed_by_agent: string | null;
}

export interface ListMessagesOptions {
  session_id: string;
  agent: string;
  /** Lower bound (inclusive) on observation ts. Default 0 = no bound. */
  since_ts?: number;
  /** Scope to a specific set of tasks. Default: every task the session
   *  participates in. */
  task_ids?: number[];
  /** Default 50; cap 200 — matches task_timeline / attention_inbox shape. */
  limit?: number;
  /** When true, only return status='unread'. Default false. */
  unread_only?: boolean;
  /** Injected for tests; defaults to the observation content snippet. */
  previewLength?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_PREVIEW_LENGTH = 120;

/**
 * Return messages addressed to this (session, agent), newest-first. A
 * message is addressed to the caller when:
 *   - metadata.to_session_id === session_id, OR
 *   - metadata.to_session_id is absent and metadata.to_agent === agent, OR
 *   - metadata.to_session_id is absent and metadata.to_agent === 'any'
 *
 * The caller's own sends are filtered out — your outbox is not your inbox.
 * This function does *not* mark messages as read; `markMessageRead` is a
 * separate explicit call so an agent can peek at its inbox during planning
 * without destroying the "you have new mail" signal for a later turn.
 *
 * Filtering rules layered on top of addressing:
 *   - Retracted messages are always hidden from recipients. The body is
 *     still in storage (and still searchable via FTS) for the sender's
 *     audit trail; recipients see only that the message is gone.
 *   - Past-TTL `unread` messages are hidden from `unread_only` queries —
 *     they no longer count as awaiting response. They keep showing in
 *     non-`unread_only` queries with their on-disk status so audit / debug
 *     callers can see "B never read this before TTL".
 *   - `to_agent='any'` broadcasts that have been claimed by another
 *     session drop out of every non-claimer inbox. The claimer keeps
 *     seeing the message normally.
 */
export function listMessagesForAgent(
  store: MemoryStore,
  opts: ListMessagesOptions,
): MessageSummary[] {
  const since = opts.since_ts ?? 0;
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const previewLen = opts.previewLength ?? DEFAULT_PREVIEW_LENGTH;
  const now = Date.now();

  const taskIds = opts.task_ids?.length
    ? [...new Set(opts.task_ids)].filter(
        (task_id) => store.storage.getParticipantAgent(task_id, opts.session_id) !== undefined,
      )
    : participatingTaskIds(store, opts.session_id);

  const out: MessageSummary[] = [];
  for (const task_id of taskIds) {
    const rows = store.storage.taskObservationsByKind(task_id, 'message', MAX_LIMIT);
    for (const r of rows) {
      if (r.ts < since) continue;
      if (r.session_id === opts.session_id) continue;
      // parseMessage backfills fields added by the messaging-overhaul
      // change (expires_at, claimed_by_*, retracted_at, retract_reason)
      // so legacy rows compare correctly against the strict-null predicates
      // below.
      const meta = parseMessage(r.metadata);
      if (!meta) continue;

      const addressedToMe = isMessageAddressedTo(meta, opts.session_id, opts.agent);
      if (!addressedToMe) continue;
      if (meta.status === 'retracted') continue;
      if (!isVisibleToBroadcastClaimant(meta, opts.session_id)) continue;

      const isExpired = meta.expires_at !== null && now > meta.expires_at;
      if (opts.unread_only) {
        if (meta.status !== 'unread') continue;
        if (isExpired) continue;
      }

      const broadcast = isBroadcastMessage(meta);
      out.push({
        id: r.id,
        task_id,
        ts: r.ts,
        from_session_id: r.session_id,
        from_agent: meta.from_agent,
        to_agent: meta.to_agent,
        to_session_id: meta.to_session_id,
        urgency: meta.urgency,
        // Surface the effective status: an unread row past TTL renders as
        // 'expired' even though the on-disk status is still 'unread'. This
        // keeps inbox consumers from having to recompute the predicate.
        status: isExpired && meta.status === 'unread' ? 'expired' : meta.status,
        reply_to: r.reply_to ?? null,
        preview: r.content.slice(0, previewLen),
        expires_at: meta.expires_at,
        is_claimable_broadcast: broadcast && meta.claimed_by_session_id === null,
        claimed_by_session_id: meta.claimed_by_session_id,
        claimed_by_agent: meta.claimed_by_agent,
      });
    }
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

function participatingTaskIds(store: MemoryStore, session_id: string): number[] {
  // Matches the scan buildAttentionInbox uses — broader than
  // findActiveTaskForSession because a message query wants every lane the
  // recipient could possibly hear from.
  const rows = store.storage.listTasks(200);
  const ids: number[] = [];
  for (const task of rows) {
    if (store.storage.getParticipantAgent(task.id, session_id) !== undefined) {
      ids.push(task.id);
    }
  }
  return ids;
}
