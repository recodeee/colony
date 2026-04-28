import type {
  AttentionInbox,
  InboxHandoff,
  InboxLane,
  InboxMessage,
  InboxWake,
} from './attention-inbox.js';
import type { MessageUrgency } from './task-thread.js';

export type AttentionItemKind = 'task_hand_off' | 'task_wake' | 'task_message' | 'stalled_lane';

export interface AttentionItem {
  kind: AttentionItemKind;
  urgency: MessageUrgency;
  summary: string;
  task_id?: number;
  observation_id?: number;
  expires_at: number | null;
  ts: number | null;
}

export interface AttentionBudgetOutput {
  prominent: AttentionItem[];
  collapsed_counts: { blocking: number; needs_reply: number; fyi: number };
  total: number;
}

const DEFAULT_MAX_PROMINENT = 3;

const URGENCY_RANK: Record<MessageUrgency, number> = {
  blocking: 2,
  needs_reply: 1,
  fyi: 0,
};

export function applyAttentionBudget(
  inbox: AttentionInbox,
  options: { max_prominent?: number } = {},
): AttentionBudgetOutput {
  const maxProminent = Math.max(0, Math.floor(options.max_prominent ?? DEFAULT_MAX_PROMINENT));
  const ranked = attentionItems(inbox)
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const urgencyDelta = URGENCY_RANK[b.item.urgency] - URGENCY_RANK[a.item.urgency];
      if (urgencyDelta !== 0) return urgencyDelta;
      const expiryDelta = expirySortValue(a.item.expires_at) - expirySortValue(b.item.expires_at);
      if (expiryDelta !== 0) return expiryDelta;
      return a.index - b.index;
    });

  const prominent = ranked
    .filter(({ item }) => item.urgency !== 'fyi')
    .slice(0, maxProminent)
    .map(({ item }) => item);
  const prominentSet = new Set(prominent);
  const collapsed_counts = { blocking: 0, needs_reply: 0, fyi: 0 };

  for (const { item } of ranked) {
    if (!prominentSet.has(item)) {
      collapsed_counts[item.urgency] += 1;
    }
  }

  return {
    prominent,
    collapsed_counts,
    total: ranked.length,
  };
}

function attentionItems(inbox: AttentionInbox): AttentionItem[] {
  return [
    ...inbox.pending_handoffs.map(handoffItem),
    ...inbox.pending_wakes.map(wakeItem),
    ...inbox.unread_messages.map(messageItem),
    ...inbox.stalled_lanes.map(stalledLaneItem),
  ];
}

function handoffItem(handoff: InboxHandoff): AttentionItem {
  return {
    kind: 'task_hand_off',
    urgency: 'needs_reply',
    summary: `${handoff.from_agent} needs your accept on handoff #${handoff.id}: ${handoff.summary}`,
    task_id: handoff.task_id,
    observation_id: handoff.id,
    expires_at: handoff.expires_at,
    ts: handoff.ts,
  };
}

function wakeItem(wake: InboxWake): AttentionItem {
  return {
    kind: 'task_wake',
    urgency: 'fyi',
    summary: `${wake.from_agent} sent wake #${wake.id}: ${wake.reason}`,
    task_id: wake.task_id,
    observation_id: wake.id,
    expires_at: wake.expires_at,
    ts: wake.ts,
  };
}

function messageItem(message: InboxMessage): AttentionItem {
  return {
    kind: 'task_message',
    urgency: message.urgency,
    summary: `${message.from_agent}: ${message.preview}`,
    task_id: message.task_id,
    observation_id: message.id,
    expires_at: message.expires_at,
    ts: message.ts,
  };
}

function stalledLaneItem(lane: InboxLane): AttentionItem {
  return {
    kind: 'stalled_lane',
    urgency: 'needs_reply',
    summary: `${lane.owner} stalled on ${lane.branch}: ${lane.task}`,
    expires_at: null,
    ts: Date.parse(lane.updated_at),
  };
}

function expirySortValue(expiresAt: number | null): number {
  return expiresAt ?? Number.POSITIVE_INFINITY;
}
