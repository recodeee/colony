import {
  type AttentionInbox,
  type HivemindSession,
  type MemoryStore,
  type PlanInfo,
  type SubtaskInfo,
  buildAttentionInbox,
  listPlans,
  readHivemind,
} from '@colony/core';
import type { TaskClaimRow, TaskRow } from '@colony/storage';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type ToolContext, defaultWrapHandler } from './context.js';
import {
  type QuotaRelayReady,
  type ReadyForAgentResult,
  type ReadyQueueEntry,
  buildReadyForAgent,
} from './ready-queue.js';

const DEFAULT_READY_LIMIT = 3;
const STARTUP_LANE_LIMIT = 8;

type RecommendedTool =
  | 'attention_inbox'
  | 'task_accept_handoff'
  | 'task_message'
  | 'task_ready_for_agent'
  | 'task_plan_claim_subtask'
  | 'task_claim_quota_accept'
  | 'task_claim_file'
  | 'task_note_working'
  | 'rescue_stranded_scan'
  | null;

interface StartupPanelTask {
  id: number;
  title: string;
  status: string;
  repo_root: string;
  branch: string;
}

interface StartupReadyTask {
  kind: 'plan_subtask' | 'quota_relay';
  task_id: number | null;
  title: string;
  plan_slug?: string;
  subtask_index?: number;
  wave_name?: string;
  file_scope?: string[];
  next_tool?: string;
  claim_args?: Record<string, unknown>;
}

interface StartupQueenPlan {
  plan_slug: string;
  plan_title: string;
  subtask_index: number;
  subtask_title: string;
  status: SubtaskInfo['status'];
  wave_name: string;
  file_scope: string[];
}

interface StartupBlockingItem {
  kind: 'message' | 'handoff' | 'wake' | 'runtime_warning';
  id?: number;
  task_id?: number | null;
  summary: string;
  next_tool?: RecommendedTool;
  next_args?: Record<string, unknown>;
}

interface StartupWarning {
  kind: 'attention' | 'quota' | 'stale' | 'runtime';
  severity: 'info' | 'warning' | 'blocking';
  message: string;
  next_tool?: RecommendedTool;
  next_args?: Record<string, unknown>;
}

interface StartupPanel {
  session_id: string;
  agent: string;
  repo_root: string | null;
  branch: string | null;
  active_task: StartupPanelTask | null;
  ready_task: StartupReadyTask | null;
  active_queen_plan: StartupQueenPlan | null;
  inbox_count: number;
  blocking_items: StartupBlockingItem[];
  claimed_files: string[];
  blocker: string | null;
  next: string;
  evidence: string | null;
  warnings: StartupWarning[];
  recommended_next_tool: RecommendedTool;
  recommended_next_args: Record<string, unknown> | null;
  copy_paste_next_mcp_calls: string[];
}

interface WorkingState {
  blocker: string | null;
  next: string | null;
  evidence: string | null;
}

export function register(server: McpServer, ctx: ToolContext): void {
  const wrapHandler = ctx.wrapHandler ?? defaultWrapHandler;
  const { store, settings } = ctx;

  server.tool(
    'startup_panel',
    'Compact startup/resume panel. Run once before work: active task, inbox blockers, ready work, claims, blocker/next/evidence, warnings, and exact next MCP call.',
    {
      session_id: z.string().min(1),
      agent: z.string().min(1),
      repo_root: z.string().min(1).optional(),
      branch: z.string().min(1).optional(),
      ready_limit: z.number().int().positive().max(10).optional(),
    },
    wrapHandler('startup_panel', async ({ session_id, agent, repo_root, branch, ready_limit }) => {
      const panel = await buildStartupPanel(store, {
        session_id,
        agent,
        ...(repo_root !== undefined ? { repo_root } : {}),
        ...(branch !== undefined ? { branch } : {}),
        ready_limit: ready_limit ?? DEFAULT_READY_LIMIT,
        claim_stale_ms: settings.claimStaleMinutes * 60_000,
        file_heat_half_life_ms: settings.fileHeatHalfLifeMinutes * 60_000,
      });
      return { content: [{ type: 'text', text: JSON.stringify(panel) }] };
    }),
  );
}

export async function buildStartupPanel(
  store: MemoryStore,
  args: {
    session_id: string;
    agent: string;
    repo_root?: string;
    branch?: string;
    ready_limit?: number;
    claim_stale_ms?: number;
    file_heat_half_life_ms?: number;
  },
): Promise<StartupPanel> {
  const snapshot = readHivemind({
    ...(args.repo_root !== undefined ? { repoRoot: args.repo_root } : {}),
    limit: STARTUP_LANE_LIMIT,
  });
  const activeTask = resolveActiveTask(store, args);
  const scopedRepoRoot = args.repo_root ?? activeTask?.repo_root ?? null;
  const activeBranch = args.branch ?? activeTask?.branch ?? sessionBranch(snapshot.sessions, args);
  const inbox = buildAttentionInbox(store, {
    session_id: args.session_id,
    agent: args.agent,
    include_stalled_lanes: true,
    ...(scopedRepoRoot !== null ? { repo_root: scopedRepoRoot } : {}),
    ...(args.claim_stale_ms !== undefined ? { claim_stale_ms: args.claim_stale_ms } : {}),
    ...(args.file_heat_half_life_ms !== undefined
      ? { file_heat_half_life_ms: args.file_heat_half_life_ms }
      : {}),
  });
  const ready = await buildReadyForAgent(store, {
    session_id: args.session_id,
    agent: args.agent,
    ...(scopedRepoRoot !== null ? { repo_root: scopedRepoRoot } : {}),
    limit: args.ready_limit ?? DEFAULT_READY_LIMIT,
  });
  const claims = activeTask ? store.storage.listClaims(activeTask.id) : [];
  const workingState = activeTask ? latestWorkingState(store, activeTask.id) : null;
  const activeQueenPlan = resolveActiveQueenPlan(store, {
    ...(scopedRepoRoot !== null ? { repo_root: scopedRepoRoot } : {}),
    session_id: args.session_id,
    ...(activeTask !== null ? { task_id: activeTask.id } : {}),
    branch: activeBranch,
  });
  const blockingItems = buildBlockingItems(inbox, args);
  const warnings = buildWarnings(inbox, ready);
  const recommendation = chooseRecommendation({
    args,
    activeTask,
    claims,
    workingState,
    ready,
    blockingItems,
  });

  return {
    session_id: args.session_id,
    agent: args.agent,
    repo_root: scopedRepoRoot,
    branch: activeBranch,
    active_task: activeTask ? compactTask(activeTask) : null,
    ready_task: compactReadyTask(ready.ready[0] ?? null),
    active_queen_plan: activeQueenPlan,
    inbox_count: inboxCount(inbox),
    blocking_items: blockingItems,
    claimed_files: claims.map((claim) => claim.file_path),
    blocker: workingState?.blocker ?? null,
    next:
      workingState?.next ??
      recommendation.next ??
      ready.next_action ??
      inbox.summary.next_action ??
      'Call task_ready_for_agent before claiming work.',
    evidence: workingState?.evidence ?? null,
    warnings,
    recommended_next_tool: recommendation.tool,
    recommended_next_args: recommendation.args,
    copy_paste_next_mcp_calls: recommendation.calls,
  };
}

function resolveActiveTask(
  store: MemoryStore,
  args: { session_id: string; repo_root?: string; branch?: string },
): TaskRow | null {
  if (args.repo_root !== undefined && args.branch !== undefined) {
    const byBranch = store.storage.findTaskByBranch(args.repo_root, args.branch);
    if (byBranch) return byBranch;
  }

  const activeTaskId = store.storage.findActiveTaskForSession(args.session_id);
  const activeTask = activeTaskId !== undefined ? store.storage.getTask(activeTaskId) : undefined;
  if (activeTask && (args.repo_root === undefined || activeTask.repo_root === args.repo_root)) {
    return activeTask;
  }
  return null;
}

function sessionBranch(
  sessions: HivemindSession[],
  args: { session_id: string; branch?: string },
): string | null {
  if (args.branch !== undefined) return args.branch;
  const session = sessions.find(
    (entry) => entry.session_key === args.session_id || entry.session_key.endsWith(args.session_id),
  );
  return session?.branch ?? null;
}

function compactTask(task: TaskRow): StartupPanelTask {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    repo_root: task.repo_root,
    branch: task.branch,
  };
}

function compactReadyTask(entry: ReadyQueueEntry | null): StartupReadyTask | null {
  if (!entry) return null;
  if (isQuotaRelayReady(entry)) {
    return {
      kind: 'quota_relay',
      task_id: entry.task_id,
      title: `Quota relay: ${entry.files.join(', ')}`,
      file_scope: entry.files,
      next_tool: entry.next_tool,
      claim_args: toJsonRecord(entry.claim_args),
    };
  }
  const readyTask: StartupReadyTask = {
    kind: 'plan_subtask',
    task_id: null,
    title: entry.title,
    plan_slug: entry.plan_slug,
    subtask_index: entry.subtask_index,
    wave_name: entry.wave_name,
    file_scope: entry.file_scope,
    claim_args: toJsonRecord(entry.claim_args),
  };
  if (entry.next_tool !== undefined) readyTask.next_tool = entry.next_tool;
  return readyTask;
}

function isQuotaRelayReady(entry: ReadyQueueEntry): entry is QuotaRelayReady {
  return 'kind' in entry && entry.kind === 'quota_relay_ready';
}

function resolveActiveQueenPlan(
  store: MemoryStore,
  args: { repo_root?: string; session_id: string; task_id?: number; branch: string | null },
): StartupQueenPlan | null {
  const plans = listPlans(store, {
    ...(args.repo_root !== undefined ? { repo_root: args.repo_root } : {}),
    limit: 2000,
  });
  for (const plan of plans) {
    const subtask = plan.subtasks.find(
      (candidate) =>
        candidate.claimed_by_session_id === args.session_id ||
        candidate.task_id === args.task_id ||
        args.branch === `spec/${plan.plan_slug}/sub-${candidate.subtask_index}`,
    );
    if (subtask) return compactQueenPlan(plan, subtask);
  }
  return null;
}

function compactQueenPlan(plan: PlanInfo, subtask: SubtaskInfo): StartupQueenPlan {
  return {
    plan_slug: plan.plan_slug,
    plan_title: plan.title,
    subtask_index: subtask.subtask_index,
    subtask_title: subtask.title,
    status: subtask.status,
    wave_name: subtask.wave_name,
    file_scope: subtask.file_scope,
  };
}

function latestWorkingState(store: MemoryStore, taskId: number): WorkingState {
  const state: WorkingState = { blocker: null, next: null, evidence: null };
  for (const row of store.storage.taskTimeline(taskId, 100)) {
    if (row.kind === 'blocker' && state.blocker === null) state.blocker = compactText(row.content);
    const parsed = parseHandoffFields(row.content);
    if (parsed.blocker !== undefined && state.blocker === null) {
      state.blocker = normalizeEmpty(parsed.blocker);
    }
    if (parsed.next !== undefined && state.next === null) state.next = normalizeEmpty(parsed.next);
    if (parsed.evidence !== undefined && state.evidence === null) {
      state.evidence = normalizeEmpty(parsed.evidence);
    }
    if (state.blocker !== null && state.next !== null && state.evidence !== null) break;
  }
  return state;
}

function parseHandoffFields(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of content.split(/[;|]\s*/)) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim().toLowerCase();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function normalizeEmpty(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /^(none|null|n\/a|-)$/.test(trimmed.toLowerCase())) return null;
  return trimmed;
}

function buildBlockingItems(
  inbox: AttentionInbox,
  args: { session_id: string; agent: string },
): StartupBlockingItem[] {
  const items: StartupBlockingItem[] = [];
  for (const message of inbox.unread_messages.filter((m) => m.urgency !== 'fyi')) {
    items.push({
      kind: 'message',
      id: message.id,
      task_id: message.task_id,
      summary: `${message.from_agent} ${message.urgency}: ${compactText(message.preview)}`,
      next_tool: message.reply_tool,
      next_args: toJsonRecord(message.reply_args),
    });
  }
  for (const handoff of inbox.pending_handoffs) {
    items.push({
      kind: 'handoff',
      id: handoff.id,
      task_id: handoff.task_id,
      summary: `${handoff.from_agent}: ${compactText(handoff.summary)}`,
      next_tool: 'task_accept_handoff',
      next_args: { handoff_observation_id: handoff.id, session_id: args.session_id },
    });
  }
  for (const wake of inbox.pending_wakes) {
    items.push({
      kind: 'wake',
      id: wake.id,
      task_id: wake.task_id,
      summary: compactText(wake.reason),
      next_tool: 'task_message',
      next_args: {
        task_id: wake.task_id,
        session_id: args.session_id,
        agent: args.agent,
        to_agent: 'any',
        to_session_id: wake.from_session_id,
        urgency: 'fyi',
        content: wake.next_step || 'ack',
      },
    });
  }
  for (const warning of inbox.omx_runtime_warnings) {
    items.push({
      kind: 'runtime_warning',
      id: warning.id,
      task_id: warning.task_id,
      summary: warning.warnings.join(', '),
      next_tool: 'attention_inbox',
      next_args: { session_id: args.session_id, agent: args.agent },
    });
  }
  return items;
}

function inboxCount(inbox: AttentionInbox): number {
  return (
    inbox.summary.pending_handoff_count +
    inbox.summary.pending_wake_count +
    inbox.summary.unread_message_count +
    inbox.summary.paused_lane_count +
    inbox.summary.omx_runtime_warning_count
  );
}

function buildWarnings(inbox: AttentionInbox, ready: ReadyForAgentResult): StartupWarning[] {
  const warnings: StartupWarning[] = [];
  if (inbox.summary.blocked) {
    warnings.push({
      kind: 'attention',
      severity: 'blocking',
      message: 'Blocking inbox message present; answer inbox before claiming work.',
      next_tool: 'attention_inbox',
      next_args: { session_id: inbox.session_id, agent: inbox.agent },
    });
  }
  if (ready.ready.some(isQuotaRelayReady)) {
    const quotaWarning: StartupWarning = {
      kind: 'quota',
      severity: 'warning',
      message: 'Quota-stopped work is ready to claim.',
      next_tool: 'task_claim_quota_accept',
    };
    if (ready.claim_args) quotaWarning.next_args = toJsonRecord(ready.claim_args);
    warnings.push(quotaWarning);
  }
  if (inbox.expired_quota_handoffs.length > 0) {
    warnings.push({
      kind: 'quota',
      severity: 'warning',
      message: `${inbox.expired_quota_handoffs.length} expired quota handoff(s) need rescue or ready-queue accept.`,
    });
  }
  if (inbox.stale_claim_signals.stale_claim_count > 0) {
    warnings.push({
      kind: 'stale',
      severity: 'warning',
      message: inbox.stale_claim_signals.sweep_suggestion,
      next_tool: 'rescue_stranded_scan',
      next_args: { stranded_after_minutes: 240 },
    });
  }
  for (const warning of inbox.omx_runtime_warnings) {
    warnings.push({
      kind: 'runtime',
      severity: 'warning',
      message: `${warning.session_id}: ${warning.warnings.join(', ')}`,
      next_tool: 'attention_inbox',
      next_args: { session_id: inbox.session_id, agent: inbox.agent },
    });
  }
  return warnings;
}

function chooseRecommendation(input: {
  args: { session_id: string; agent: string; repo_root?: string };
  activeTask: TaskRow | null;
  claims: TaskClaimRow[];
  workingState: WorkingState | null;
  ready: ReadyForAgentResult;
  blockingItems: StartupBlockingItem[];
}): {
  tool: RecommendedTool;
  args: Record<string, unknown> | null;
  calls: string[];
  next?: string;
} {
  const firstBlocking = input.blockingItems[0];
  if (firstBlocking?.next_tool) {
    const nextArgs = firstBlocking.next_args ?? null;
    return {
      tool: firstBlocking.next_tool,
      args: nextArgs,
      calls: nextArgs ? [mcpCall(firstBlocking.next_tool, nextArgs)] : [],
      next: `Resolve ${firstBlocking.kind} before claiming work.`,
    };
  }

  if (input.workingState?.blocker) {
    return {
      tool: null,
      args: null,
      calls: [],
      next: 'Stop and resolve blocker before more edits.',
    };
  }

  if (input.activeTask) {
    const tool = input.claims.length > 0 ? 'task_note_working' : 'task_claim_file';
    const nextArgs =
      input.claims.length > 0
        ? {
            session_id: input.args.session_id,
            repo_root: input.activeTask.repo_root,
            branch: input.activeTask.branch,
            content: `branch=${input.activeTask.branch}; task=${input.activeTask.title}; blocker=none; next=<next>; evidence=<evidence>`,
          }
        : {
            task_id: input.activeTask.id,
            session_id: input.args.session_id,
            file_path: '<file>',
            note: 'pre-edit claim',
          };
    return {
      tool,
      args: nextArgs,
      calls: [mcpCall(tool, nextArgs)],
      next:
        input.claims.length > 0
          ? 'Resume active lane and keep working-state note current.'
          : 'Claim touched files before editing active lane.',
    };
  }

  if (input.ready.next_tool && input.ready.claim_args) {
    const args = toJsonRecord(input.ready.claim_args);
    return {
      tool: input.ready.next_tool,
      args,
      calls: [mcpCall(input.ready.next_tool, args)],
      next: input.ready.next_action,
    };
  }

  const readyArgs = {
    session_id: input.args.session_id,
    agent: input.args.agent,
    ...(input.args.repo_root !== undefined ? { repo_root: input.args.repo_root } : {}),
  };
  return {
    tool: 'task_ready_for_agent',
    args: readyArgs,
    calls: [mcpCall('task_ready_for_agent', readyArgs)],
    next: 'No active lane; ask ready queue for claimable work.',
  };
}

function mcpCall(tool: string, args: Record<string, unknown>): string {
  return `mcp__colony__${tool}(${JSON.stringify(args)})`;
}

function compactText(value: string, limit = 180): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}...` : compact;
}

function toJsonRecord(value: object): Record<string, unknown> {
  return { ...value };
}
