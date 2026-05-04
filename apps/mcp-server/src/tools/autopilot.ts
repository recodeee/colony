import {
  type AttentionInbox,
  type AttentionInboxOptions,
  type InboxHandoff,
  type InboxLane,
  type InboxMessage,
  type InboxQuotaPendingClaim,
  buildAttentionInbox,
} from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type ToolContext, defaultWrapHandler } from './context.js';
import { type ReadyForAgentResult, buildReadyForAgent } from './ready-queue.js';

export type AutopilotDecision =
  | 'accept_handoff'
  | 'accept_quota_relay'
  | 'reply_blocking_message'
  | 'claim_ready'
  | 'continue_current'
  | 'no_op';

export interface AutopilotSignals {
  pending_handoff_count: number;
  quota_pending_claim_count: number;
  unread_message_count: number;
  blocking_message_count: number;
  ready_subtask_count: number;
  stalled_lane_count: number;
  /**
   * Stalled lanes whose surface activity is just session-start noise — not
   * abandoned work-in-progress. Excluded from `actionable_stalled_lane_count`
   * so callers don't escalate on dead heartbeats.
   */
  dead_heartbeat_lane_count: number;
  actionable_stalled_lane_count: number;
}

export interface AutopilotTickResult {
  generated_at: number;
  decision: AutopilotDecision;
  reason: string;
  next_tool: string | null;
  next_args: Record<string, unknown> | null;
  signals: AutopilotSignals;
  /**
   * One short next-action sentence the caller can echo to the user. Mirrors
   * the convention used in attention_inbox / task_ready_for_agent.
   */
  next_action: string;
  /**
   * Sleep hint for self-paced loops (Claude Code's ScheduleWakeup, cron, the
   * /loop skill). Caller is the loop — this server is stateless.
   */
  suggested_wake_seconds: number;
}

const DEAD_HEARTBEAT_TASK_PATTERNS = [
  /^session start\b/i,
  /^no active swarm\b/i,
  /^heartbeat\b/i,
  /^tool:\s*colony\./i,
];

const DEFAULT_NO_OP_WAKE_SECONDS = 1200;
const SHORT_WAKE_SECONDS = 60;
const MEDIUM_WAKE_SECONDS = 270;

export function register(server: McpServer, ctx: ToolContext): void {
  const wrapHandler = ctx.wrapHandler ?? defaultWrapHandler;
  const { store, settings } = ctx;

  server.tool(
    'task_autopilot_tick',
    'One-shot autopilot advisor. Combines attention_inbox + task_ready_for_agent into one decision and returns the next tool + args + sleep hint. Stateless; the loop lives in the caller (ScheduleWakeup, /loop skill, cron).',
    {
      session_id: z.string().min(1),
      agent: z.string().min(1),
      repo_root: z.string().min(1).optional(),
      stalled_lane_limit: z.number().int().positive().max(100).optional(),
    },
    wrapHandler('task_autopilot_tick', async (args) => {
      const inboxOptions: AttentionInboxOptions = {
        session_id: args.session_id,
        agent: args.agent,
      };
      if (args.repo_root !== undefined) inboxOptions.repo_root = args.repo_root;
      if (args.stalled_lane_limit !== undefined) {
        inboxOptions.stalled_lane_limit = args.stalled_lane_limit;
      }
      inboxOptions.claim_stale_ms = settings.claimStaleMinutes * 60_000;
      inboxOptions.file_heat_half_life_ms = settings.fileHeatHalfLifeMinutes * 60_000;

      const inbox = buildAttentionInbox(store, inboxOptions);
      const ready = await buildReadyForAgent(store, {
        session_id: args.session_id,
        agent: args.agent,
        ...(args.repo_root !== undefined ? { repo_root: args.repo_root } : {}),
      });

      const tick = decideNextAction(inbox, ready, args);
      return { content: [{ type: 'text', text: JSON.stringify(tick) }] };
    }),
  );
}

export function decideNextAction(
  inbox: AttentionInbox,
  ready: ReadyForAgentResult,
  args: { session_id: string; agent: string; repo_root?: string | undefined },
): AutopilotTickResult {
  const signals = computeSignals(inbox, ready);

  // Priority 1: pending handoff for this session.
  const handoff = firstPendingHandoff(inbox.pending_handoffs);
  if (handoff) {
    return tick(
      'accept_handoff',
      `pending handoff observation_id=${handoff.id} on task ${handoff.task_id}`,
      'task_accept_handoff',
      {
        session_id: args.session_id,
        agent: args.agent,
        observation_id: handoff.id,
      },
      `Accept pending handoff on task ${handoff.task_id}.`,
      SHORT_WAKE_SECONDS,
      signals,
    );
  }

  // Priority 2: quota-pending relay claim ready for adoption.
  const relay = firstQuotaPendingClaim(inbox.quota_pending_claims);
  if (relay) {
    return tick(
      'accept_quota_relay',
      `quota-pending claim from ${relay.old_owner.session_id} on task ${relay.task_id}`,
      'task_claim_quota_accept',
      {
        ...relay.suggested_actions.accept.args,
        // Caller's session/agent override whatever the inbox emitted.
        session_id: args.session_id,
        agent: args.agent,
      },
      `Adopt quota-stopped task ${relay.task_id}.`,
      SHORT_WAKE_SECONDS,
      signals,
    );
  }

  // Priority 3: unread blocking message — caller must read before claiming.
  const blocking = firstBlockingMessage(inbox.unread_messages);
  if (blocking) {
    return tick(
      'reply_blocking_message',
      `blocking message ${blocking.id} on task ${blocking.task_id}; read before choosing other work`,
      'task_message_mark_read',
      { ...blocking.mark_read_args },
      `Read blocking message on task ${blocking.task_id} before claiming new work.`,
      SHORT_WAKE_SECONDS,
      signals,
    );
  }

  // Priority 4: claim a ready subtask if one is available.
  if (ready.claim_required && ready.next_tool && ready.claim_args) {
    const reason = ready.next_action_reason ?? ready.next_action;
    const decision: AutopilotDecision =
      ready.next_tool === 'task_claim_quota_accept' ? 'accept_quota_relay' : 'claim_ready';
    return tick(
      decision,
      reason,
      ready.next_tool,
      { ...ready.claim_args },
      ready.next_action,
      SHORT_WAKE_SECONDS,
      signals,
    );
  }

  // Priority 5: continue work on current claim.
  const continuing = continuingClaim(ready);
  if (continuing) {
    return tick(
      'continue_current',
      `holding claim on ${continuing.plan_slug}/sub-${continuing.subtask_index}; finish before switching`,
      'task_plan_complete_subtask',
      {
        session_id: args.session_id,
        agent: args.agent,
        plan_slug: continuing.plan_slug,
        subtask_index: continuing.subtask_index,
      },
      `Continue ${continuing.plan_slug}/sub-${continuing.subtask_index}; complete or hand off.`,
      MEDIUM_WAKE_SECONDS,
      signals,
    );
  }

  // No actionable signal — stay idle and let the caller's loop resleep.
  return tick(
    'no_op',
    signals.actionable_stalled_lane_count > 0
      ? `${signals.actionable_stalled_lane_count} actionable stalled lane(s); takeover optional, otherwise idle`
      : 'no pending work; idle',
    null,
    null,
    signals.actionable_stalled_lane_count > 0
      ? 'Idle. Stalled lanes exist but none are owned by this agent.'
      : 'Idle. No claimable work; caller may sleep.',
    DEFAULT_NO_OP_WAKE_SECONDS,
    signals,
  );
}

function computeSignals(inbox: AttentionInbox, ready: ReadyForAgentResult): AutopilotSignals {
  const stalled = inbox.stalled_lanes;
  const dead = stalled.filter(isDeadHeartbeatLane).length;
  const actionable = stalled.length - dead;
  const blocking = inbox.unread_messages.filter((entry) => entry.urgency === 'blocking').length;
  return {
    pending_handoff_count: inbox.pending_handoffs.length,
    quota_pending_claim_count: inbox.quota_pending_claims.length,
    unread_message_count: inbox.unread_messages.length,
    blocking_message_count: blocking,
    ready_subtask_count: ready.ready.length,
    stalled_lane_count: stalled.length,
    dead_heartbeat_lane_count: dead,
    actionable_stalled_lane_count: actionable,
  };
}

function isDeadHeartbeatLane(lane: InboxLane): boolean {
  const title = lane.task.trim();
  if (DEAD_HEARTBEAT_TASK_PATTERNS.some((pattern) => pattern.test(title))) return true;
  return lane.activity === 'dead' && title.length === 0;
}

function firstPendingHandoff(handoffs: readonly InboxHandoff[]): InboxHandoff | null {
  return handoffs[0] ?? null;
}

function firstQuotaPendingClaim(
  claims: readonly InboxQuotaPendingClaim[],
): InboxQuotaPendingClaim | null {
  return claims[0] ?? null;
}

function firstBlockingMessage(messages: readonly InboxMessage[]): InboxMessage | null {
  return messages.find((entry) => entry.urgency === 'blocking') ?? null;
}

function continuingClaim(
  ready: ReadyForAgentResult,
): { plan_slug: string; subtask_index: number } | null {
  for (const entry of ready.ready) {
    if ('reason' in entry && entry.reason === 'continue_current_task') {
      return { plan_slug: entry.plan_slug, subtask_index: entry.subtask_index };
    }
  }
  return null;
}

function tick(
  decision: AutopilotDecision,
  reason: string,
  nextTool: string | null,
  nextArgs: Record<string, unknown> | null,
  nextAction: string,
  wakeSeconds: number,
  signals: AutopilotSignals,
): AutopilotTickResult {
  return {
    generated_at: Date.now(),
    decision,
    reason,
    next_tool: nextTool,
    next_args: nextArgs,
    signals,
    next_action: nextAction,
    suggested_wake_seconds: wakeSeconds,
  };
}
