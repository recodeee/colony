import {
  type AgentProfile,
  type ClaimHolder,
  type MemoryStore,
  type SubtaskInfo,
  claimsForPaths,
  listPlans,
  loadProfile,
  rankCandidates,
} from '@colony/core';
import type { ObservationRow } from '@colony/storage';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';

const DEFAULT_LIMIT = 5;
const RELEASE_DENSITY_WINDOW_MS = 60 * 60 * 1000;
const PLAN_SUBTASK_KIND = 'plan-subtask';
const PLAN_SUBTASK_CLAIM_KIND = 'plan-subtask-claim';
const CAPABILITY_HINT_TEXT: Record<string, string> = {
  ui_work: 'ui',
  api_work: 'api',
  test_work: 'test',
  infra_work: 'build config pipeline',
  doc_work: 'doc',
};

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
  reasoning: string;
}

interface RankedSubtask extends ReadySubtask {
  created_at: number;
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
        only_with_available_subtasks: true,
        limit: 2000,
      });
      const profile = loadProfile(store.storage, agent);
      const tasksById = new Map(
        store.storage
          .listTasks(2000)
          .map((t) => [t.id, { created_at: t.created_at, created_by: t.created_by }]),
      );
      const ranked = plans
        .flatMap((plan) =>
          plan.next_available.map((subtask) =>
            rankSubtask(store, {
              plan_slug: plan.plan_slug,
              subtask,
              session_id,
              profile,
              parent_plan_created_by: tasksById.get(plan.spec_task_id)?.created_by ?? null,
              created_at: tasksById.get(subtask.task_id)?.created_at ?? plan.created_at,
            }),
          ),
        )
        .sort((a, b) => b.fit_score - a.fit_score || a.created_at - b.created_at);

      return jsonReply({
        ready: ranked
          .slice(0, limit ?? DEFAULT_LIMIT)
          .map(({ created_at: _createdAt, ...entry }) => entry),
        total_available: ranked.length,
      });
    },
  );
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
    plan_slug: args.plan_slug,
    subtask_index: args.subtask.subtask_index,
    wave_index: args.subtask.wave_index,
    wave_name: args.subtask.wave_name,
    blocked_by_count: args.subtask.blocked_by_count,
    title: args.subtask.title,
    capability_hint: args.subtask.capability_hint,
    file_scope: args.subtask.file_scope,
    fit_score: fitScore,
    reasoning: buildReasoning({
      capability_hint: args.subtask.capability_hint,
      capability_match: capabilityMatch,
      file_count: args.subtask.file_scope.length,
      conflicts,
      recent_claim_density: recentClaimDensity,
      queen_bonus: queenBonus,
    }),
    created_at: args.created_at,
  };
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
