import {
  type AgentProfile,
  type ClaimHolder,
  type MemoryStore,
  type SubtaskInfo,
  claimsForPaths,
  listMessagesForAgent,
  listPlans,
  loadProfile,
  rankCandidates,
} from '@colony/core';
import type { ObservationRow } from '@colony/storage';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { type CompactNegativeWarning, searchNegativeWarnings } from './shared.js';

const DEFAULT_LIMIT = 5;
const RELEASE_DENSITY_WINDOW_MS = 60 * 60 * 1000;
const CURRENT_TASK_SWITCH_MARGIN = 0.2;
const RECENT_CLAIM_COOLDOWN_MS = 20 * 60 * 1000;
const RECENT_CLAIM_COOLDOWN_MARGIN = 0.05;
const PLAN_SUBTASK_KIND = 'plan-subtask';
const PLAN_SUBTASK_CLAIM_KIND = 'plan-subtask-claim';
const CAPABILITY_HINT_TEXT: Record<string, string> = {
  ui_work: 'ui',
  api_work: 'api',
  test_work: 'test',
  infra_work: 'build config pipeline',
  doc_work: 'doc',
};

type ReadyReason = 'continue_current_task' | 'urgent_override' | 'ready_high_score';

interface ReadySubtask {
  plan_slug: string;
  subtask_index: number;
  wave_index: number;
  wave_name: string;
  blocked_by_count: number;
  title: string;
  capability_hint: string | null;
  file_scope: string[];
  fit_score: number;
  reason: ReadyReason;
  reasoning: string;
}

interface RankedSubtask extends ReadySubtask {
  task_id: number;
  created_at: number;
  claim_ts: number | null;
  current_claim: boolean;
}

interface ScopeConflict {
  file_path: string;
  holder: ClaimHolder;
}

export function register(server: McpServer, ctx: ToolContext): void {
  const { store } = ctx;

  server.tool(
    'task_ready_for_agent',
    'Find the next task to claim for this agent. Use this when deciding what to work on. Returns ready sub-tasks ranked by fit_score with wave metadata, capability hints, claim conflicts, and blocked work filtered out.',
    {
      session_id: z.string().min(1),
      agent: z.string().min(1),
      repo_root: z.string().min(1).optional(),
      limit: z.number().int().positive().max(20).optional(),
    },
    async ({ session_id, agent, repo_root, limit }) => {
      const plans = listPlans(store, {
        ...(repo_root !== undefined ? { repo_root } : {}),
        limit: 2000,
      });
      const profile = loadProfile(store.storage, agent);
      const tasksById = new Map(
        store.storage
          .listTasks(2000)
          .map((t) => [t.id, { created_at: t.created_at, created_by: t.created_by }]),
      );
      const available = plans.flatMap((plan) =>
        plan.next_available.map((subtask) =>
          rankSubtask(store, {
            plan_slug: plan.plan_slug,
            subtask,
            session_id,
            profile,
            parent_plan_created_by: tasksById.get(plan.spec_task_id)?.created_by ?? null,
            created_at: tasksById.get(subtask.task_id)?.created_at ?? plan.created_at,
            reason: 'ready_high_score',
            current_claim: false,
          }),
        ),
      );
      const currentClaims = plans.flatMap((plan) =>
        plan.subtasks
          .filter(
            (subtask) =>
              subtask.status === 'claimed' && subtask.claimed_by_session_id === session_id,
          )
          .map((subtask) =>
            rankSubtask(store, {
              plan_slug: plan.plan_slug,
              subtask,
              session_id,
              profile,
              parent_plan_created_by: tasksById.get(plan.spec_task_id)?.created_by ?? null,
              created_at: tasksById.get(subtask.task_id)?.created_at ?? plan.created_at,
              reason: 'continue_current_task',
              current_claim: true,
            }),
          ),
      );
      const urgentTaskIds = blockingMessageTaskIds(store, {
        session_id,
        agent,
        task_ids: [...new Set([...available, ...currentClaims].map((task) => task.task_id))],
      });
      const ranked = rankForSelection(
        available.map((task) =>
          urgentTaskIds.has(task.task_id) ? { ...task, reason: 'urgent_override' } : task,
        ),
        currentClaims,
      );

      const selected = ranked.slice(0, limit ?? DEFAULT_LIMIT);
      const ready = await Promise.all(
        selected.map(
          async ({
            created_at: _createdAt,
            task_id: _taskId,
            claim_ts: _claimTs,
            current_claim: _currentClaim,
            ...entry
          }) => ({
            ...entry,
            negative_warnings: await readyNegativeWarnings(store, entry),
          }),
        ),
      );

      return jsonReply({
        ready,
        total_available: available.length,
      });
    },
  );
}

async function readyNegativeWarnings(
  store: MemoryStore,
  entry: ReadySubtask,
): Promise<CompactNegativeWarning[]> {
  const seen = new Set<number>();
  const warnings: CompactNegativeWarning[] = [];
  for (const query of readyWarningQueries(entry)) {
    const hits = await searchNegativeWarnings(store, query, 3);
    for (const hit of hits) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      warnings.push(hit);
      if (warnings.length >= 3) return warnings;
    }
  }
  return warnings;
}

function readyWarningQueries(entry: ReadySubtask): string[] {
  const queries = [
    compactTitleQuery(entry.title),
    ...entry.file_scope.map(fileTokenQuery),
    entry.title,
  ].filter((query) => query.length > 0);
  return [...new Set(queries)].map((query) => query.slice(0, 800));
}

function compactTitleQuery(title: string): string {
  const stop = new Set([
    'add',
    'review',
    'update',
    'implement',
    'fix',
    'create',
    'protect',
    'keep',
    'the',
    'a',
    'an',
    'and',
    'to',
    'for',
  ]);
  return title
    .split(/\s+/)
    .filter((token) => token && !stop.has(token.toLowerCase()))
    .join(' ');
}

function fileTokenQuery(filePath: string): string {
  return filePath
    .split(/[^A-Za-z0-9_]+/)
    .filter(Boolean)
    .slice(-3)
    .join(' ');
}

function rankSubtask(
  store: MemoryStore,
  args: {
    plan_slug: string;
    subtask: SubtaskInfo;
    session_id: string;
    profile: AgentProfile;
    parent_plan_created_by: string | null;
    created_at: number;
    reason: ReadyReason;
    current_claim: boolean;
  },
): RankedSubtask {
  const capabilityMatch = capabilityMatchScore(args.subtask.capability_hint, args.profile);
  const conflicts = scopeConflicts(store, args.subtask.file_scope, args.session_id);
  const scopeConflictPenalty = conflicts.length > 0 ? 1 : 0;
  const recentClaimDensity = recentReleaseDensity(store, args.subtask.file_scope);
  const queenBonus = args.parent_plan_created_by === 'queen' ? 0.1 : 0;
  const fitScore = clampScore(
    capabilityMatch - 0.3 * scopeConflictPenalty - 0.1 * recentClaimDensity + queenBonus,
  );

  return {
    task_id: args.subtask.task_id,
    plan_slug: args.plan_slug,
    subtask_index: args.subtask.subtask_index,
    wave_index: args.subtask.wave_index,
    wave_name: args.subtask.wave_name,
    blocked_by_count: args.subtask.blocked_by_count,
    title: args.subtask.title,
    capability_hint: args.subtask.capability_hint,
    file_scope: args.subtask.file_scope,
    fit_score: fitScore,
    reason: args.reason,
    reasoning: buildReasoning({
      capability_hint: args.subtask.capability_hint,
      capability_match: capabilityMatch,
      file_count: args.subtask.file_scope.length,
      conflicts,
      recent_claim_density: recentClaimDensity,
      queen_bonus: queenBonus,
    }),
    created_at: args.created_at,
    claim_ts: args.current_claim
      ? currentClaimTimestamp(store, args.subtask.task_id, args.session_id)
      : null,
    current_claim: args.current_claim,
  };
}

function rankForSelection(
  available: RankedSubtask[],
  currentClaims: RankedSubtask[],
): RankedSubtask[] {
  const orderedCurrent = [...currentClaims].sort(compareCurrentClaims);
  const activeCurrent = orderedCurrent[0] ?? null;
  if (!activeCurrent) {
    return [...available].sort(compareReady);
  }

  const switchMargin =
    activeCurrent.claim_ts !== null &&
    Date.now() - activeCurrent.claim_ts < RECENT_CLAIM_COOLDOWN_MS
      ? CURRENT_TASK_SWITCH_MARGIN + RECENT_CLAIM_COOLDOWN_MARGIN
      : CURRENT_TASK_SWITCH_MARGIN;
  const highScoreThreshold = activeCurrent.fit_score + switchMargin;

  return [...available, ...orderedCurrent].sort((a, b) => {
    const priorityDelta =
      selectionPriority(a, highScoreThreshold) - selectionPriority(b, highScoreThreshold);
    if (priorityDelta !== 0) return priorityDelta;
    if (a.current_claim || b.current_claim) return compareCurrentClaims(a, b);
    return compareReady(a, b);
  });
}

function selectionPriority(task: RankedSubtask, highScoreThreshold: number): number {
  if (task.reason === 'urgent_override') return 0;
  if (!task.current_claim && task.fit_score >= highScoreThreshold) return 1;
  if (task.current_claim) return 2;
  return 3;
}

function compareReady(a: RankedSubtask, b: RankedSubtask): number {
  return (
    b.fit_score - a.fit_score ||
    a.created_at - b.created_at ||
    a.plan_slug.localeCompare(b.plan_slug) ||
    a.subtask_index - b.subtask_index
  );
}

function compareCurrentClaims(a: RankedSubtask, b: RankedSubtask): number {
  const aClaim = a.claim_ts ?? a.created_at;
  const bClaim = b.claim_ts ?? b.created_at;
  return (
    bClaim - aClaim ||
    b.fit_score - a.fit_score ||
    a.created_at - b.created_at ||
    a.plan_slug.localeCompare(b.plan_slug) ||
    a.subtask_index - b.subtask_index
  );
}

function blockingMessageTaskIds(
  store: MemoryStore,
  args: { session_id: string; agent: string; task_ids: number[] },
): Set<number> {
  if (args.task_ids.length === 0) return new Set();
  return new Set(
    listMessagesForAgent(store, {
      session_id: args.session_id,
      agent: args.agent,
      task_ids: args.task_ids,
      unread_only: true,
      limit: 200,
    })
      .filter((message) => message.urgency === 'blocking')
      .map((message) => message.task_id),
  );
}

function currentClaimTimestamp(
  store: MemoryStore,
  taskId: number,
  sessionId: string,
): number | null {
  const row = store.storage
    .taskObservationsByKind(taskId, PLAN_SUBTASK_CLAIM_KIND, 500)
    .find((entry) => {
      const meta = parseMeta(entry.metadata);
      return meta.status === 'claimed' && meta.session_id === sessionId;
    });
  return row?.ts ?? null;
}

function capabilityMatchScore(capabilityHint: string | null, profile: AgentProfile): number {
  if (capabilityHint === null) return 0.5;
  const summary = CAPABILITY_HINT_TEXT[capabilityHint] ?? capabilityHint.replace(/_/g, ' ');
  return clampScore(rankCandidates({ summary }, [profile])[0]?.score ?? 0);
}

function scopeConflicts(
  store: MemoryStore,
  fileScope: string[],
  sessionId: string,
): ScopeConflict[] {
  return [...claimsForPaths(store, fileScope).entries()]
    .filter((entry): entry is [string, ClaimHolder] => {
      const holder = entry[1];
      return holder !== null && holder.session_id !== sessionId;
    })
    .map(([file_path, holder]) => ({ file_path, holder }));
}

function recentReleaseDensity(store: MemoryStore, fileScope: string[]): number {
  if (fileScope.length === 0) return 0;
  const scope = new Set(fileScope);
  const since = Date.now() - RELEASE_DENSITY_WINDOW_MS;
  let density = 0;

  for (const task of store.storage.listTasks(2000)) {
    const rows = store.storage.taskTimeline(task.id, 500);
    const subtaskScope = readInitialSubtaskScope(rows);
    for (const row of rows) {
      if (row.ts < since) continue;
      const meta = parseMeta(row.metadata);
      density += countReleasedFiles(meta, scope);
      if (row.kind === PLAN_SUBTASK_CLAIM_KIND && meta.status === 'completed') {
        density += countOverlap(subtaskScope, scope);
      }
    }
  }

  return density;
}

function readInitialSubtaskScope(rows: ObservationRow[]): string[] {
  const initial = rows.find((row) => row.kind === PLAN_SUBTASK_KIND);
  if (!initial) return [];
  const meta = parseMeta(initial.metadata);
  return readStringArray(meta.file_scope);
}

function countReleasedFiles(meta: Record<string, unknown>, scope: Set<string>): number {
  return [
    ...readStringArray(meta.released_files),
    ...readStringArray(meta.transferred_files),
  ].filter((file) => scope.has(file)).length;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function countOverlap(files: string[], scope: Set<string>): number {
  return files.filter((file) => scope.has(file)).length;
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function buildReasoning(args: {
  capability_hint: string | null;
  capability_match: number;
  file_count: number;
  conflicts: ScopeConflict[];
  recent_claim_density: number;
  queen_bonus: number;
}): string {
  const capability =
    args.capability_hint === null
      ? `neutral unhinted fit (${formatScore(args.capability_match)})`
      : `${fitLabel(args.capability_match)} ${args.capability_hint} fit (${formatScore(
          args.capability_match,
        )})`;
  const scope =
    args.conflicts.length === 0
      ? 'scope clear of live claims'
      : `${args.conflicts.length} of ${args.file_count} files in scope held by ${holderSummary(
          args.conflicts,
        )}`;
  const queen = args.queen_bonus > 0 ? '; queen-published plan, +0.1 fit boost' : '';
  return `${capability}; ${scope}; recent claim density ${args.recent_claim_density}${queen}`;
}

function holderSummary(conflicts: ScopeConflict[]): string {
  const holders = [
    ...new Set(
      conflicts.map((conflict) =>
        conflict.holder.agent
          ? `${conflict.holder.agent}@${conflict.holder.session_id}`
          : conflict.holder.session_id,
      ),
    ),
  ];
  return holders.slice(0, 3).join(', ');
}

function fitLabel(score: number): string {
  if (score >= 0.75) return 'strong';
  if (score >= 0.5) return 'solid';
  return 'weak';
}

function formatScore(score: number): string {
  return score.toFixed(2);
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}

function jsonReply(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}
