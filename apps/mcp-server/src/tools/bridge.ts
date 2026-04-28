import {
  type AttentionInbox,
  type MemoryStore,
  buildAttentionInbox,
  readHivemind,
} from '@colony/core';
import type { TaskClaimRow, TaskRow } from '@colony/storage';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type ToolContext, defaultWrapHandler } from './context.js';
import { type ReadySubtaskWithWarnings, buildReadyForAgent } from './ready-queue.js';
import {
  type HivemindContext,
  type HivemindContextLane,
  buildContextQuery,
  buildHivemindContext,
  toHivemindOptions,
} from './shared.js';

const BRIDGE_LANE_LIMIT = 8;
const BRIDGE_READY_LIMIT = 3;
const BRIDGE_PREVIEW_LIMIT = 3;
const BRIDGE_NOTE_LIMIT = 240;
const BRIDGE_EVIDENCE_LIMIT = 8;

type RuntimeSource = 'omx' | 'colony';

interface BridgeStatus {
  schema: 'colony.omx_hud_status.v1';
  generated_at: string;
  runtime_source: RuntimeSource;
  branch: string | null;
  task: string | null;
  blocker: string | null;
  next: string;
  evidence: {
    task_id: number | null;
    latest_working_note_id: number | null;
    attention_observation_ids: number[];
    attention_observation_ids_truncated: boolean;
    hydrate_with: 'get_observations';
  };
  attention: {
    unread_count: number;
    blocking_count: number;
    blocking: boolean;
    pending_handoff_count: number;
    pending_wake_count: number;
    stalled_lane_count: number;
  };
  ready_work_count: number;
  ready_work_preview: Array<{
    title: string;
    plan_slug: string;
    subtask_index: number;
    reason: ReadySubtaskWithWarnings['reason'];
    fit_score: number;
    capability_hint: string | null;
    file_count: number;
    file_scope_preview: string[];
  }>;
  claimed_files: Array<{
    task_id: number;
    file_path: string;
    by_session_id: string;
    claimed_at: number;
    yours: boolean;
  }>;
  latest_working_note: {
    id: number;
    task_id: number;
    session_id: string;
    ts: number;
    content: string;
  } | null;
}

export function register(server: McpServer, ctx: ToolContext): void {
  const wrapHandler = ctx.wrapHandler ?? defaultWrapHandler;
  const { store } = ctx;

  server.tool(
    'bridge_status',
    'Show compact bridge status for OMX HUD/status. Returns branch/task/blocker/next/evidence, attention counts, ready count, claims, and latest note without observation bodies.',
    {
      session_id: z.string().min(1),
      agent: z.string().min(1),
      repo_root: z.string().min(1),
      branch: z.string().min(1).optional(),
      query: z.string().min(1).optional(),
    },
    wrapHandler('bridge_status', async ({ session_id, agent, repo_root, branch, query }) => {
      const snapshot = readHivemind(
        toHivemindOptions({
          repo_root,
          repo_roots: undefined,
          include_stale: true,
          limit: BRIDGE_LANE_LIMIT,
        }),
      );
      const attentionInbox = buildAttentionInbox(store, {
        session_id,
        agent,
        repo_root,
        recent_claim_limit: BRIDGE_PREVIEW_LIMIT,
        unread_message_limit: BRIDGE_PREVIEW_LIMIT,
        file_heat_limit: BRIDGE_PREVIEW_LIMIT,
      });
      const attentionIds = bridgeAttentionObservationIds(attentionInbox);
      const context = buildHivemindContext(
        snapshot,
        [],
        [],
        buildContextQuery(query, snapshot.sessions),
        {
          maxClaims: BRIDGE_PREVIEW_LIMIT,
          maxHotFiles: BRIDGE_PREVIEW_LIMIT,
          attention: {
            session_id,
            agent,
            summary: attentionInbox.summary,
            observation_ids: attentionIds.ids,
            observation_ids_truncated: attentionIds.truncated,
          },
        },
      );
      const ready = await buildReadyForAgent(store, {
        session_id,
        agent,
        repo_root,
        limit: BRIDGE_READY_LIMIT,
      });

      return jsonReply(
        buildBridgeStatus({
          context,
          store,
          runtimeSource: snapshot.sessions.some((lane) => lane.source === 'active-session')
            ? 'omx'
            : 'colony',
          branch,
          sessionId: session_id,
          repoRoot: repo_root,
          blockingCount: attentionInbox.unread_messages.filter((m) => m.urgency === 'blocking')
            .length,
          ready: ready.ready,
          readyCount: ready.total_available,
        }),
      );
    }),
  );
}

function buildBridgeStatus(input: {
  context: HivemindContext;
  store: MemoryStore;
  runtimeSource: RuntimeSource;
  branch: string | undefined;
  sessionId: string;
  repoRoot: string;
  blockingCount: number;
  ready: ReadySubtaskWithWarnings[];
  readyCount: number;
}): BridgeStatus {
  const activeLane = selectActiveLane(input.context.lanes, input.branch);
  const task = resolveBridgeTask(input);
  const latestWorkingNote = task ? latestNote(input.store, task.id) : null;
  const claimedFiles = task ? taskClaims(input.store, task.id, input.sessionId) : [];
  const nextAction = nextBridgeAction(input.context, input.ready, activeLane);
  return {
    schema: 'colony.omx_hud_status.v1',
    generated_at: input.context.generated_at,
    runtime_source: input.runtimeSource,
    branch: task?.branch ?? activeLane?.branch ?? input.branch ?? null,
    task: task?.title ?? activeLane?.task ?? null,
    blocker: bridgeBlocker(input.context, activeLane),
    next: nextAction,
    evidence: {
      task_id: task?.id ?? null,
      latest_working_note_id: latestWorkingNote?.id ?? null,
      attention_observation_ids: input.context.attention.observation_ids,
      attention_observation_ids_truncated: input.context.attention.observation_ids_truncated,
      hydrate_with: 'get_observations',
    },
    attention: {
      unread_count: input.context.attention.unread_messages,
      blocking_count: input.blockingCount,
      blocking: input.context.attention.blocking,
      pending_handoff_count: input.context.attention.pending_handoffs,
      pending_wake_count: input.context.attention.pending_wakes,
      stalled_lane_count: input.context.attention.stalled_lanes,
    },
    ready_work_count: input.readyCount,
    ready_work_preview: input.ready.slice(0, BRIDGE_READY_LIMIT).map(compactReadyItem),
    claimed_files: claimedFiles,
    latest_working_note: latestWorkingNote,
  };
}

function selectActiveLane(
  lanes: HivemindContextLane[],
  branch: string | undefined,
): HivemindContextLane | null {
  if (branch) {
    const matching = lanes.find((lane) => lane.branch === branch);
    if (matching) return matching;
  }
  return (
    lanes.find((lane) => lane.source === 'active-session' && lane.activity !== 'dead') ??
    lanes[0] ??
    null
  );
}

function compactReadyItem(item: ReadySubtaskWithWarnings): BridgeStatus['ready_work_preview'][0] {
  return {
    title: item.title,
    plan_slug: item.plan_slug,
    subtask_index: item.subtask_index,
    reason: item.reason,
    fit_score: item.fit_score,
    capability_hint: item.capability_hint,
    file_count: item.file_scope.length,
    file_scope_preview: item.file_scope.slice(0, BRIDGE_PREVIEW_LIMIT),
  };
}

function resolveBridgeTask(input: {
  context: HivemindContext;
  store: MemoryStore;
  branch: string | undefined;
  sessionId: string;
  repoRoot: string;
}): TaskRow | null {
  if (input.branch) {
    const task = taskByBranch(input.store, input.repoRoot, input.branch);
    if (task) return task;
  }
  const activeTaskId = input.store.storage.findActiveTaskForSession(input.sessionId);
  if (activeTaskId !== undefined) {
    const task = input.store.storage.getTask(activeTaskId);
    if (task?.repo_root === input.repoRoot) return task;
  }
  const activeLane = selectActiveLane(input.context.lanes, input.branch);
  return activeLane ? taskByBranch(input.store, input.repoRoot, activeLane.branch) : null;
}

function taskByBranch(store: MemoryStore, repoRoot: string, branch: string): TaskRow | null {
  return store.storage.findTaskByBranch(repoRoot, branch) ?? null;
}

function taskClaims(
  store: MemoryStore,
  taskId: number,
  sessionId: string,
): BridgeStatus['claimed_files'] {
  return store.storage
    .listClaims(taskId)
    .sort((left: TaskClaimRow, right: TaskClaimRow) => right.claimed_at - left.claimed_at)
    .slice(0, BRIDGE_PREVIEW_LIMIT)
    .map((claim: TaskClaimRow) => ({
      task_id: claim.task_id,
      file_path: claim.file_path,
      by_session_id: claim.session_id,
      claimed_at: claim.claimed_at,
      yours: claim.session_id === sessionId,
    }));
}

function latestNote(store: MemoryStore, taskId: number): BridgeStatus['latest_working_note'] {
  const row = store.storage.taskTimeline(taskId, 50).find((entry) => entry.kind === 'note');
  if (!row) return null;
  const expanded = store.getObservations([row.id], { expand: true })[0];
  return {
    id: row.id,
    task_id: taskId,
    session_id: row.session_id,
    ts: row.ts,
    content: truncateOneLine(expanded?.content ?? row.content, BRIDGE_NOTE_LIMIT),
  };
}

function bridgeBlocker(
  context: HivemindContext,
  activeLane: HivemindContextLane | null,
): string | null {
  if (context.attention.blocking) return 'blocking attention';
  if (context.attention.pending_handoffs > 0) return 'pending handoff';
  if (context.attention.pending_wakes > 0) return 'pending wake';
  if (context.attention.stalled_lanes > 0) return 'stalled lane';
  if (activeLane?.needs_attention) return activeLane.risk;
  return null;
}

function nextBridgeAction(
  context: HivemindContext,
  ready: ReadySubtaskWithWarnings[],
  activeLane: HivemindContextLane | null,
): string {
  if (
    context.attention.blocking ||
    context.attention.pending_handoffs > 0 ||
    context.attention.pending_wakes > 0 ||
    context.attention.unread_messages > 0 ||
    context.attention.stalled_lanes > 0
  ) {
    return context.attention.next_action;
  }
  const nextReady = ready[0];
  if (nextReady) {
    return `Claim ready work via task_plan_claim_subtask: ${nextReady.title}`;
  }
  if (activeLane?.needs_attention) {
    return `Review ${activeLane.risk}: ${activeLane.branch}`;
  }
  if (activeLane) {
    return `Continue ${activeLane.branch}.`;
  }
  return 'No immediate Colony action.';
}

function bridgeAttentionObservationIds(inbox: AttentionInbox): {
  ids: number[];
  truncated: boolean;
} {
  const ids = [
    ...inbox.unread_messages.filter((m) => m.urgency === 'blocking').map((m) => m.id),
    ...inbox.pending_handoffs.map((h) => h.id),
    ...inbox.pending_wakes.map((w) => w.id),
    ...inbox.unread_messages.filter((m) => m.urgency === 'needs_reply').map((m) => m.id),
    ...inbox.coalesced_messages.map((m) => m.latest_id),
    ...inbox.read_receipts.map((r) => r.read_message_id),
  ];
  const unique = [...new Set(ids)];
  return {
    ids: unique.slice(0, BRIDGE_EVIDENCE_LIMIT),
    truncated: unique.length > BRIDGE_EVIDENCE_LIMIT,
  };
}

function truncateOneLine(value: string, max: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 3))}...`;
}

function jsonReply(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}
