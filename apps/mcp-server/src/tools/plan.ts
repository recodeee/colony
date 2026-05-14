import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type MemoryStore,
  type PlanInfo,
  type SubtaskInfo,
  type SubtaskLookup,
  TaskThread,
  areDepsMet,
  findSubtaskBySpecRow,
  guardedClaimFile,
  listPlans,
  readSubtaskByBranch,
  recordReflexion,
  resolveManagedRepoRoot,
} from '@colony/core';
import {
  type PlanWorkspaceManifest,
  type PlanWorkspaceTaskInput,
  PublishPlanError,
  type PublishPlanSubtaskInput,
  type Spec,
  SpecRepository,
  SyncEngine,
  listPlanWorkspaces,
  parseSpec,
  planTaskCounts,
  publishPlan,
  serializeChange,
  serializeSpec,
  syncPlanWorkspaceTasks,
} from '@colony/spec';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { parseMeta } from './_meta.js';
import { type ToolContext, defaultWrapHandler } from './context.js';
import { withPlanPublishGuidance } from './plan-output.js';
import { buildPlanValidationSummary } from './plan-validation-summary.js';
import { mcpError, mcpErrorResponse } from './shared.js';

const SubtaskInputSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  file_scope: z.array(z.string().min(1)).min(1),
  depends_on: z.array(z.number().int().nonnegative()).optional(),
  spec_row_id: z.string().optional(),
  capability_hint: z
    .enum(['ui_work', 'api_work', 'test_work', 'infra_work', 'doc_work'])
    .optional(),
});

const WaveInputSchema = z
  .object({
    name: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    subtask_indexes: z.array(z.number().int().nonnegative()).min(1).optional(),
    subtask_indices: z.array(z.number().int().nonnegative()).min(1).optional(),
    titles: z.array(z.string().min(1)).min(1).optional(),
    subtask_refs: z.array(z.string().min(1)).min(1).optional(),
  })
  .refine(
    (wave) =>
      wave.subtask_indexes !== undefined ||
      wave.subtask_indices !== undefined ||
      wave.titles !== undefined ||
      wave.subtask_refs !== undefined,
    'wave needs subtask_indexes, subtask_indices, titles, or subtask_refs',
  );

const OrderingHintsSchema = z
  .object({
    mode: z.enum(['wave', 'ordered_waves']).optional(),
    waves: z.array(WaveInputSchema).min(1).optional(),
  })
  .optional();

type SubtaskInput = z.infer<typeof SubtaskInputSchema>;
type WaveInput = z.infer<typeof WaveInputSchema>;

interface CodedError extends Error {
  __code?: string;
}

const PLAN_ROOT_BRANCH_RE = /^spec\/([a-z0-9-]+)$/;
const PLAN_ARCHIVED_WARNING_KIND = 'blocker';
const PLAN_ARCHIVED_WARNING_CODE = 'PLAN_ARCHIVED';

interface CompactSubtask {
  subtask_index: number;
  title: string;
  status: SubtaskInfo['status'];
  capability_hint: string | null;
  wave_index: number;
  blocked_by_count: number;
  claimed_by_session_id: string | null;
}

interface CompactPlan {
  plan_slug: string;
  repo_root: string;
  spec_task_id: number;
  registry_status: PlanInfo['registry_status'];
  title: string;
  created_at: number;
  subtask_counts: PlanInfo['subtask_counts'];
  subtask_count: number;
  next_available_count: number;
  next_available: CompactSubtask[];
  subtask_indexes: number[];
}

interface PlanArchivedSuggestedReplacement {
  action: 'publish-new-plan';
  summary: string;
  repo_root: string;
  plan_slug: string;
  command: string;
  tool_call: string;
}

interface PlanArchivedFallback {
  code: 'PLAN_ARCHIVED';
  message: string;
  details: {
    plan_slug: string;
    subtask_index: number;
    archived_plan_task_id: number;
    repo_root: string;
    suggested_replacement: PlanArchivedSuggestedReplacement;
    warning_observation_id: number | null;
  };
}

/**
 * Compact projection of a `PlanInfo` for the `task_plan_list` MCP wire
 * shape. Drops `subtasks[].description` and `subtasks[].file_scope` —
 * the two heavy fields driving the per-call token spend — and reduces
 * `next_available` to its routing essentials. Callers needing the full
 * sub-task bodies must pass `detail: 'full'` to recover the legacy
 * shape. Internal callers continue to use `listPlans()` directly and
 * are unaffected.
 */
function toCompactSubtask(subtask: SubtaskInfo): CompactSubtask {
  return {
    subtask_index: subtask.subtask_index,
    title: subtask.title,
    status: subtask.status,
    capability_hint: subtask.capability_hint,
    wave_index: subtask.wave_index,
    blocked_by_count: subtask.blocked_by_count,
    claimed_by_session_id: subtask.claimed_by_session_id,
  };
}

/**
 * Build recovery hints attached to a `task_plan_claim_subtask` error.
 * Adds the next claimable sub-task index for the same plan when the
 * caller raced and the requested sub-task is no longer available, so
 * the caller can retry without a follow-up `task_plan_list` round
 * trip. Returns an empty record when the failure code does not benefit
 * from a recovery hint (caller already knows what to do).
 */
function recoveryDetailsForClaimFailure(
  store: MemoryStore,
  code:
    | 'PLAN_SUBTASK_NOT_FOUND'
    | 'PLAN_SUBTASK_DEPS_UNMET'
    | 'PLAN_SUBTASK_NOT_AVAILABLE'
    | 'PLAN_ARCHIVED'
    | 'CLAIM_TAKEOVER_RECOMMENDED'
    | 'CLAIM_HELD_BY_ACTIVE_OWNER',
  args: { plan_slug: string; subtask_index: number; repo_root?: string },
): Record<string, unknown> {
  if (code !== 'PLAN_SUBTASK_NOT_AVAILABLE') return {};
  try {
    const plan = listPlans(store, {
      ...(args.repo_root !== undefined ? { repo_root: args.repo_root } : {}),
      limit: 200,
    }).find((candidate) => candidate.plan_slug === args.plan_slug);
    if (!plan) return {};
    const candidates = plan.next_available
      .filter((subtask) => subtask.subtask_index !== args.subtask_index)
      .map(toCompactSubtask);
    return {
      plan_slug: args.plan_slug,
      subtask_counts: plan.subtask_counts,
      next_available_count: candidates.length,
      next_available_subtask_index: candidates[0]?.subtask_index ?? null,
      next_available: candidates,
    };
  } catch {
    return {};
  }
}

/**
 * Build a synthetic `PlanInfo` for an on-disk plan workspace that has
 * not yet been published into Colony. Workers cannot claim from these
 * (no task threads exist), but surfacing them lets callers warn the
 * operator that `colony plan publish <slug>` is required before the
 * fleet can pick the work up.
 */
function diskWorkspaceToPlanInfo(
  workspace: { dir: string; manifest: PlanWorkspaceManifest },
  repoRoot: string,
): PlanInfo {
  const m = workspace.manifest;
  const counts = planTaskCounts(m.tasks);
  const subtasks: SubtaskInfo[] = m.tasks.map((task) => ({
    task_id: 0,
    subtask_index: task.subtask_index,
    title: task.title,
    description: task.description,
    status: task.status,
    claimed_at: null,
    file_scope: task.file_scope,
    depends_on: task.depends_on,
    wave_index: 0,
    wave_name: 'unpublished',
    blocked_by_count: 0,
    blocked_by: [],
    spec_row_id: task.spec_row_id,
    capability_hint: task.capability_hint,
    claimed_by_session_id: task.claimed_by_session_id,
    claimed_by_agent: task.claimed_by_agent,
    parent_plan_slug: m.plan_slug,
    parent_plan_title: m.title,
    parent_spec_task_id: null,
  }));
  const nextAvailable = subtasks.filter((s) => s.status === 'available' && areDepsMet(s, subtasks));
  return {
    plan_slug: m.plan_slug,
    repo_root: repoRoot,
    spec_task_id: 0,
    registry_status: 'unpublished',
    title: m.title,
    created_at: Date.parse(m.created_at) || 0,
    subtask_counts: counts as Record<SubtaskInfo['status'], number>,
    subtasks,
    next_available: nextAvailable,
  };
}

/**
 * Merge unpublished disk plan workspaces into a registered-plans list.
 * Skips any workspace whose slug is already represented (registered or
 * subtask-only) so the same plan never appears twice.
 */
function mergeUnpublishedDiskPlans(
  registered: PlanInfo[],
  repoRoot: string | undefined,
): PlanInfo[] {
  if (!repoRoot) return registered;
  let workspaces: ReturnType<typeof listPlanWorkspaces>;
  try {
    workspaces = listPlanWorkspaces(repoRoot);
  } catch {
    return registered;
  }
  if (workspaces.length === 0) return registered;
  const known = new Set(registered.map((p) => p.plan_slug));
  const unpublished = workspaces
    .filter((w) => !known.has(w.manifest.plan_slug))
    .map((w) => diskWorkspaceToPlanInfo(w, repoRoot));
  return [...registered, ...unpublished];
}

function toCompactPlan(plan: PlanInfo): CompactPlan {
  return {
    plan_slug: plan.plan_slug,
    repo_root: plan.repo_root,
    spec_task_id: plan.spec_task_id,
    registry_status: plan.registry_status,
    title: plan.title,
    created_at: plan.created_at,
    subtask_counts: plan.subtask_counts,
    subtask_count: plan.subtasks.length,
    next_available_count: plan.next_available.length,
    next_available: plan.next_available.map(toCompactSubtask),
    subtask_indexes: plan.subtasks.map((s) => s.subtask_index),
  };
}

export function register(server: McpServer, ctx: ToolContext): void {
  const wrapHandler = ctx.wrapHandler ?? defaultWrapHandler;
  const { store } = ctx;

  server.tool(
    'task_plan_publish',
    [
      'Split a large task into claimable parallel sub-tasks. Creates a spec change document at',
      'openspec/changes/<slug>/CHANGE.md, opens one task thread per sub-task on',
      'spec/<slug>/sub-N branches, and links them via metadata.parent_plan_slug.',
      'Refuses to publish if independent sub-tasks have overlapping file scopes',
      '(use depends_on to sequence overlapping work). Originating agent does NOT',
      'auto-join sub-tasks — claim via task_plan_claim_subtask.',
    ].join(' '),
    {
      repo_root: z.string().min(1),
      slug: z
        .string()
        .min(1)
        .regex(/^[a-z0-9-]+$/, 'kebab-case only'),
      session_id: z.string().min(1),
      agent: z.string().min(1),
      title: z.string().min(1),
      problem: z.string().min(1).describe('Why this plan exists. Becomes spec change §problem.'),
      acceptance_criteria: z
        .array(z.string().min(1))
        .min(1)
        .describe('What "done" looks like for the whole plan, not per sub-task.'),
      subtasks: z
        .array(SubtaskInputSchema)
        .min(2)
        .max(20)
        .describe('At least 2 sub-tasks — if it is one task, use task_thread directly.'),
      waves: z
        .array(WaveInputSchema)
        .min(1)
        .optional()
        .describe(
          'Optional ordered wave groups. Each wave references flat subtasks by subtask_indexes/subtask_indices, titles, or subtask_refs. Publishing reorders subtasks by wave and adds dependencies on the previous wave.',
        ),
      ordering_hints: OrderingHintsSchema.describe(
        'Optional ordered-wave hints. Use { mode: "wave", waves: [...] } when wrapping wave input.',
      ),
      auto_archive: z
        .boolean()
        .optional()
        .describe(
          'When true, the parent spec change auto-archives via three-way merge after the last sub-task completes. Defaults to false because silent state change after the final completion is risky if the merged spec has not been verified — opt in per plan once you trust the lane. Conflicts block auto-archive (surface as a plan-archive-blocked observation) instead of forcing.',
        ),
    },
    wrapHandler('task_plan_publish', async (args) => {
      try {
        const ordered = applyOrderedWaveHints(args.subtasks, {
          topLevelWaves: args.waves,
          orderingHints: args.ordering_hints,
        });
        const validation = buildPlanValidationSummary({
          store,
          repo_root: args.repo_root,
          subtasks: ordered.subtasks,
          runtime: ctx.planValidation,
        });
        const result = publishPlan({
          store,
          repo_root: args.repo_root,
          slug: args.slug,
          session_id: args.session_id,
          agent: args.agent,
          title: args.title,
          problem: args.problem,
          acceptance_criteria: args.acceptance_criteria,
          subtasks: ordered.subtasks,
          auto_archive: args.auto_archive ?? false,
        });
        store.addObservation({
          session_id: args.session_id,
          task_id: result.spec_task_id,
          kind: 'plan-validation',
          content: `plan ${args.slug} validation: ${validation.finding_count} finding(s), blocking=${validation.blocking}`,
          metadata: { ...validation },
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ...withPlanPublishGuidance(result, ordered.subtasks, {
                  wave_names: ordered.waveNames,
                }),
                plan_validation: validation,
              }),
            },
          ],
        };
      } catch (err) {
        if (err instanceof PublishPlanError) {
          return mcpErrorResponse(err.code, err.message);
        }
        return mcpError(err);
      }
    }),
  );

  server.tool(
    'task_plan_list',
    'Find available plan sub-tasks, rollups, or next work. Lists registered plans (and, by default, surfaces on-disk plan workspaces that have not been published yet, marked with registry_status="unpublished") with status counts, next_available work, capability_match, and unclaimed routing. Workers cannot claim from unpublished plans — surface them so the orchestrator notices and runs `colony plan publish <slug>`. Defaults to a compact rollup shape; pass detail="full" for descriptions and file_scope.',
    {
      repo_root: z.string().min(1).optional(),
      only_with_available_subtasks: z.boolean().optional(),
      capability_match: z
        .enum(['ui_work', 'api_work', 'test_work', 'infra_work', 'doc_work'])
        .optional(),
      limit: z.number().int().positive().max(50).optional(),
      detail: z
        .enum(['compact', 'full'])
        .optional()
        .describe(
          'compact (default): one rollup row + next_available indexes/titles. full: legacy shape with subtasks[] descriptions and file_scope. Use compact for ready-work selection; full when you need to render every sub-task body.',
        ),
      include_unpublished: z
        .boolean()
        .optional()
        .describe(
          'Default true. When true, scans openspec/plans/* and includes any disk workspace whose slug is not yet registered, marked registry_status="unpublished". Pass false to mirror the legacy registered-only behavior.',
        ),
    },
    wrapHandler('task_plan_list', async (args) => {
      // Opportunistic auto-archive sweep: completed plans whose grace
      // window has elapsed get archived before the listing returns. This
      // is the daemon-less trigger that flips queen_plan_readiness from
      // bad to good without requiring an operator to call colony plan
      // close manually.
      sweepCompletedPlansForAutoArchive(store, args.repo_root);
      const plans = listPlans(store, {
        ...(args.repo_root !== undefined ? { repo_root: args.repo_root } : {}),
        ...(args.only_with_available_subtasks !== undefined
          ? { only_with_available_subtasks: args.only_with_available_subtasks }
          : {}),
        ...(args.capability_match !== undefined ? { capability_match: args.capability_match } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      const includeUnpublished = args.include_unpublished ?? true;
      const merged = includeUnpublished ? mergeUnpublishedDiskPlans(plans, args.repo_root) : plans;
      const detail = args.detail ?? 'compact';
      const payload = detail === 'full' ? merged : merged.map(toCompactPlan);
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    }),
  );

  server.tool(
    'task_plan_claim_subtask',
    'Claim a plan sub-task and its files for your session. Joins the sub-task thread, activates file claims, and refuses unmet dependencies or already-claimed work.',
    {
      plan_slug: z.string().min(1),
      subtask_index: z.number().int().nonnegative(),
      session_id: z.string().min(1),
      agent: z.string().min(1),
      repo_root: z.string().min(1).optional(),
      file_scope: z.array(z.string().min(1)).optional(),
    },
    wrapHandler('task_plan_claim_subtask', async (args) => {
      const result = attemptClaimPlanSubtask(store, args);
      if (!result.ok) {
        if (result.code === 'CLAIM_INTERNAL_ERROR') return mcpError(result.exception);
        if (result.code === 'PLAN_ARCHIVED') {
          return mcpErrorResponse(result.code, result.message, result.details);
        }
        const details = recoveryDetailsForClaimFailure(store, result.code, {
          plan_slug: args.plan_slug,
          subtask_index: args.subtask_index,
          ...(args.repo_root !== undefined ? { repo_root: args.repo_root } : {}),
        });
        return mcpErrorResponse(result.code, result.message, details);
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              task_id: result.task_id,
              branch: result.branch,
              file_scope: result.file_scope,
            }),
          },
        ],
      };
    }),
  );

  server.tool(
    'task_plan_complete_subtask',
    'Complete a plan sub-task and release its file claims. Marks status completed, records summary rollup, and unlocks downstream depends_on sub-tasks.',
    {
      plan_slug: z.string().min(1),
      subtask_index: z.number().int().nonnegative(),
      session_id: z.string().min(1),
      summary: z.string().min(1).describe('What landed. Surfaces in the parent plan rollup.'),
    },
    wrapHandler('task_plan_complete_subtask', async (args) => {
      const branch = `spec/${args.plan_slug}/sub-${args.subtask_index}`;
      const located = readSubtaskByBranch(store, branch);
      if (!located) {
        const archived = planArchivedFallback(store, {
          plan_slug: args.plan_slug,
          subtask_index: args.subtask_index,
          session_id: args.session_id,
        });
        if (archived) return mcpErrorResponse(archived.code, archived.message, archived.details);
        return mcpErrorResponse('PLAN_SUBTASK_NOT_FOUND', `no sub-task at ${branch}`);
      }
      if (located.info.status !== 'claimed') {
        return mcpErrorResponse(
          'PLAN_SUBTASK_NOT_CLAIMED',
          `sub-task is ${located.info.status}, not claimed`,
        );
      }
      if (located.info.claimed_by_session_id !== args.session_id) {
        return mcpErrorResponse(
          'PLAN_SUBTASK_NOT_YOURS',
          `sub-task is claimed by ${located.info.claimed_by_session_id ?? '(nobody)'}, not ${args.session_id}`,
        );
      }

      const specDelta = prepareSpecRowCompletionDelta(store, {
        plan_slug: args.plan_slug,
        subtask: located.info,
      });
      if (specDelta) writeFileAtomic(specDelta.path, specDelta.nextContent);

      try {
        store.storage.transaction(() => {
          for (const file of located.info.file_scope) {
            store.storage.releaseClaim({
              task_id: located.task_id,
              file_path: file,
              session_id: args.session_id,
            });
          }
          store.addObservation({
            session_id: args.session_id,
            task_id: located.task_id,
            kind: 'plan-subtask-claim',
            content: args.summary,
            metadata: {
              status: 'completed',
              session_id: args.session_id,
              agent: located.info.claimed_by_agent ?? 'unknown',
              plan_slug: args.plan_slug,
              subtask_index: args.subtask_index,
              completed_at: Date.now(),
            },
          });
          if (specDelta) {
            store.addObservation({
              session_id: args.session_id,
              task_id: located.info.parent_spec_task_id as number,
              kind: 'spec-delta',
              content: `modify ${specDelta.specRowId} = ${specDelta.rowCells.join(' | ')}`,
            });
          }
        });
      } catch (err) {
        if (specDelta) revertSpecChange(specDelta);
        throw err;
      }

      const parentTask = store.storage
        .listTasks(2000)
        .find((task) => task.id === located.info.parent_spec_task_id);
      if (parentTask) {
        syncPlanWorkspaceTasks({
          repoRoot: parentTask.repo_root,
          slug: args.plan_slug,
          tasks: readPlanSubtasks(store, args.plan_slug).map((subtask) =>
            subtaskInfoToWorkspaceTask(subtask, {
              completedSubtaskIndex: args.subtask_index,
              summary: args.summary,
            }),
          ),
        });
      }

      // Auto-archive: when this completion was the last outstanding sub-task
      // and the plan opted in at publish time, three-way-merge the change
      // and archive it. Failures are non-fatal and surface as observations
      // on the parent spec task rather than tearing down the completion.
      const autoArchive = runAutoArchiveIfReady(store, {
        plan_slug: args.plan_slug,
        parent_spec_task_id: located.info.parent_spec_task_id,
        session_id: args.session_id,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'completed',
              auto_archive: autoArchive,
            }),
          },
        ],
      };
    }),
  );

  server.tool(
    'task_plan_status_for_spec_row',
    'Check whether a spec row already has a plan sub-task. Returns binding, status, claimed_by session, branch, and parent plan metadata when covered.',
    {
      repo_root: z.string().min(1),
      spec_row_id: z.string().min(1),
    },
    wrapHandler('task_plan_status_for_spec_row', async (args) => {
      const found = findSubtaskBySpecRow(store, args.repo_root, args.spec_row_id);
      if (!found) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                spec_row_id: args.spec_row_id,
                binding: null,
                status: null,
              }),
            },
          ],
        };
      }

      const binding = {
        plan_slug: found.info.parent_plan_slug,
        subtask_index: found.info.subtask_index,
        task_id: found.task_id,
        branch: found.branch,
        spec_row_id: found.info.spec_row_id,
      };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ...binding,
              status: found.info.status,
              claimed_by_session_id: found.info.claimed_by_session_id,
              claimed_by_agent: found.info.claimed_by_agent,
              binding,
            }),
          },
        ],
      };
    }),
  );
}

export type ClaimPlanSubtaskArgs = {
  plan_slug: string;
  subtask_index: number;
  session_id: string;
  agent: string;
};

export type ClaimPlanSubtaskResult =
  | { ok: true; task_id: number; branch: string; file_scope: string[] }
  | ({ ok: false } & PlanArchivedFallback)
  | {
      ok: false;
      code:
        | 'PLAN_SUBTASK_NOT_FOUND'
        | 'PLAN_SUBTASK_DEPS_UNMET'
        | 'PLAN_SUBTASK_NOT_AVAILABLE'
        | 'CLAIM_TAKEOVER_RECOMMENDED'
        | 'CLAIM_HELD_BY_ACTIVE_OWNER';
      message: string;
      exception?: undefined;
    }
  | { ok: false; code: 'CLAIM_INTERNAL_ERROR'; message: string; exception: unknown };

/**
 * Race-safe claim of a plan sub-task. Extracted from the
 * `task_plan_claim_subtask` MCP handler so the ready-queue path can
 * opt into a server-side auto-claim without re-implementing the
 * lifecycle. Returns a discriminated result instead of throwing —
 * MCP handlers map non-`ok` results to `mcpErrorResponse` codes.
 */
export function attemptClaimPlanSubtask(
  store: MemoryStore,
  args: ClaimPlanSubtaskArgs,
): ClaimPlanSubtaskResult {
  const branch = `spec/${args.plan_slug}/sub-${args.subtask_index}`;
  const located = readSubtaskByBranch(store, branch);
  if (!located) {
    const archived = planArchivedFallback(store, {
      plan_slug: args.plan_slug,
      subtask_index: args.subtask_index,
      session_id: args.session_id,
    });
    if (archived) return { ok: false, ...archived };
    return { ok: false, code: 'PLAN_SUBTASK_NOT_FOUND', message: `no sub-task at ${branch}` };
  }

  const allTasks = store.storage.listTasks(2000);
  const siblings = allTasks
    .filter((t) => {
      const m = t.branch.match(/^spec\/([a-z0-9-]+)\/sub-(\d+)$/);
      return Boolean(m && m[1] === args.plan_slug);
    })
    .map((t) => readSubtaskByBranch(store, t.branch))
    .filter((s): s is SubtaskLookup => s !== null)
    .map((s) => s.info);

  if (!areDepsMet(located.info, siblings)) {
    const unmet = located.info.depends_on.filter((idx) => {
      const dep = siblings.find((s) => s.subtask_index === idx);
      return dep?.status !== 'completed';
    });
    return {
      ok: false,
      code: 'PLAN_SUBTASK_DEPS_UNMET',
      message: `dependencies not met: sub-tasks [${unmet.join(', ')}] are not completed`,
    };
  }

  try {
    const claimBlock = store.storage.transaction(
      (): {
        code: 'CLAIM_TAKEOVER_RECOMMENDED' | 'CLAIM_HELD_BY_ACTIVE_OWNER';
        message: string;
      } | null => {
        const fresh = readSubtaskByBranch(store, branch);
        if (!fresh) {
          const err: CodedError = new Error(`no sub-task at ${branch}`);
          err.__code = 'PLAN_SUBTASK_NOT_AVAILABLE';
          throw err;
        }
        if (fresh.info.status !== 'available') {
          const err: CodedError = new Error(
            `sub-task is ${fresh.info.status}${
              fresh.info.claimed_by_session_id ? ` by ${fresh.info.claimed_by_session_id}` : ''
            }`,
          );
          err.__code = 'PLAN_SUBTASK_NOT_AVAILABLE';
          throw err;
        }
        for (const file of fresh.info.file_scope) {
          const guarded = guardedClaimFile(store, {
            task_id: fresh.task_id,
            file_path: file,
            session_id: args.session_id,
            agent: args.agent,
            dryRun: true,
          });
          if (guarded.status === 'takeover_recommended') {
            return {
              code: 'CLAIM_TAKEOVER_RECOMMENDED',
              message:
                guarded.recommendation ?? 'release or take over inactive claim before claiming',
            };
          }
          if (guarded.status === 'blocked_active_owner') {
            return {
              code: 'CLAIM_HELD_BY_ACTIVE_OWNER',
              message:
                guarded.recommendation ?? 'request handoff or explicit takeover before claiming',
            };
          }
        }
        store.addObservation({
          session_id: args.session_id,
          task_id: fresh.task_id,
          kind: 'plan-subtask-claim',
          content: `${args.agent} claimed sub-task ${args.subtask_index} of plan ${args.plan_slug}`,
          metadata: {
            status: 'claimed',
            session_id: args.session_id,
            agent: args.agent,
            plan_slug: args.plan_slug,
            subtask_index: args.subtask_index,
          },
        });
        const thread = new TaskThread(store, fresh.task_id);
        thread.join(args.session_id, args.agent);
        for (const file of fresh.info.file_scope) {
          const guarded = guardedClaimFile(store, {
            task_id: fresh.task_id,
            file_path: file,
            session_id: args.session_id,
            agent: args.agent,
          });
          if (guarded.status === 'takeover_recommended') {
            const err: CodedError = new Error(
              guarded.recommendation ?? 'release or take over inactive claim before claiming',
            );
            err.__code = 'CLAIM_TAKEOVER_RECOMMENDED';
            throw err;
          }
          if (guarded.status === 'blocked_active_owner') {
            const err: CodedError = new Error(
              guarded.recommendation ?? 'request handoff or explicit takeover before claiming',
            );
            err.__code = 'CLAIM_HELD_BY_ACTIVE_OWNER';
            throw err;
          }
        }
        return null;
      },
    );
    if (claimBlock) {
      return { ok: false, code: claimBlock.code, message: claimBlock.message };
    }
  } catch (err) {
    const code = (err as CodedError).__code;
    if (
      code === 'PLAN_SUBTASK_NOT_AVAILABLE' ||
      code === 'CLAIM_TAKEOVER_RECOMMENDED' ||
      code === 'CLAIM_HELD_BY_ACTIVE_OWNER'
    ) {
      return { ok: false, code, message: (err as Error).message };
    }
    return {
      ok: false,
      code: 'CLAIM_INTERNAL_ERROR',
      message: err instanceof Error ? err.message : String(err),
      exception: err,
    };
  }

  return {
    ok: true,
    task_id: located.task_id,
    branch,
    file_scope: located.info.file_scope,
  };
}

function planArchivedFallback(
  store: MemoryStore,
  args: { plan_slug: string; subtask_index: number; session_id: string },
): PlanArchivedFallback | null {
  const parent = findArchivedPlanRootBySlug(store, args.plan_slug);
  if (!parent) return null;

  const warningObservationId = postPlanArchivedWarningOnce(store, {
    parent_task_id: parent.id,
    session_id: args.session_id,
    plan_slug: args.plan_slug,
    subtask_index: args.subtask_index,
    repo_root: parent.repo_root,
  });
  const suggestedReplacement = suggestedArchivedPlanReplacement(parent.repo_root, args.plan_slug);
  return {
    code: PLAN_ARCHIVED_WARNING_CODE,
    message: `plan ${args.plan_slug} is archived; stale sub-task spec/${args.plan_slug}/sub-${args.subtask_index} cannot be claimed or completed`,
    details: {
      plan_slug: args.plan_slug,
      subtask_index: args.subtask_index,
      archived_plan_task_id: parent.id,
      repo_root: parent.repo_root,
      suggested_replacement: suggestedReplacement,
      warning_observation_id: warningObservationId,
    },
  };
}

function findArchivedPlanRootBySlug(
  store: MemoryStore,
  planSlug: string,
): { id: number; repo_root: string; status: string } | null {
  const branch = `spec/${planSlug}`;
  const candidates = store.storage
    .listTasks(2000)
    .filter((task) => task.branch === branch && PLAN_ROOT_BRANCH_RE.test(task.branch));
  return (
    candidates.find((task) => task.status === 'archived' || task.status === 'auto-archived') ?? null
  );
}

function suggestedArchivedPlanReplacement(
  repoRoot: string,
  planSlug: string,
): PlanArchivedSuggestedReplacement {
  return {
    action: 'publish-new-plan',
    summary: 'Archived plan references are stale; publish a replacement plan for remaining work.',
    repo_root: repoRoot,
    plan_slug: planSlug,
    command: `colony queen plan --repo-root ${JSON.stringify(repoRoot)} "<goal>"`,
    tool_call:
      'mcp__colony__queen_plan_goal({ session_id: "<session_id>", repo_root: "<repo_root>", goal_title: "<goal>", problem: "<problem>", acceptance_criteria: ["<done>"] })',
  };
}

function postPlanArchivedWarningOnce(
  store: MemoryStore,
  args: {
    parent_task_id: number;
    session_id: string;
    plan_slug: string;
    subtask_index: number;
    repo_root: string;
  },
): number | null {
  const existing = store.storage
    .taskObservationsByKind(args.parent_task_id, PLAN_ARCHIVED_WARNING_KIND, 100)
    .some((row) => {
      const metadata = parseMeta(row.metadata);
      return (
        metadata.code === PLAN_ARCHIVED_WARNING_CODE &&
        metadata.plan_slug === args.plan_slug &&
        metadata.subtask_index === args.subtask_index
      );
    });
  if (existing) return null;

  return new TaskThread(store, args.parent_task_id).post({
    session_id: args.session_id,
    kind: PLAN_ARCHIVED_WARNING_KIND,
    content: `PLAN_ARCHIVED: stale sub-task spec/${args.plan_slug}/sub-${args.subtask_index} targets archived plan ${args.plan_slug}; publish replacement work instead of retrying.`,
    metadata: {
      code: PLAN_ARCHIVED_WARNING_CODE,
      plan_slug: args.plan_slug,
      subtask_index: args.subtask_index,
      repo_root: args.repo_root,
      suggested_replacement: suggestedArchivedPlanReplacement(args.repo_root, args.plan_slug),
    },
  });
}

function applyOrderedWaveHints(
  subtasks: SubtaskInput[],
  args: {
    topLevelWaves: WaveInput[] | undefined;
    orderingHints:
      | {
          mode?: 'wave' | 'ordered_waves' | undefined;
          waves?: WaveInput[] | undefined;
        }
      | undefined;
  },
): { subtasks: PublishPlanSubtaskInput[]; waveNames?: string[] | undefined } {
  const waves = args.topLevelWaves ?? args.orderingHints?.waves;
  if (!waves || waves.length === 0) return { subtasks };

  const waveIndexes = resolveWaveIndexes(waves, subtasks);
  const assigned = new Set(waveIndexes.flatMap((wave) => wave.indexes));
  const unassigned = subtasks.map((_, index) => index).filter((index) => !assigned.has(index));
  const allWaves =
    unassigned.length > 0
      ? [...waveIndexes, { name: `Wave ${waveIndexes.length + 1}`, indexes: unassigned }]
      : waveIndexes;
  const orderedOriginalIndexes = allWaves.flatMap((wave) => wave.indexes);
  const oldToNew = new Map(
    orderedOriginalIndexes.map((oldIndex, newIndex) => [oldIndex, newIndex]),
  );
  const waveForOldIndex = new Map<number, number>();
  allWaves.forEach((wave, waveIndex) => {
    for (const oldIndex of wave.indexes) waveForOldIndex.set(oldIndex, waveIndex);
  });

  const orderedSubtasks: PublishPlanSubtaskInput[] = [];
  let previousWaveIndexes: number[] = [];
  for (let waveIndex = 0; waveIndex < allWaves.length; waveIndex++) {
    const wave = allWaves[waveIndex];
    if (!wave) continue;
    const currentWaveIndexes: number[] = [];

    for (const oldIndex of wave.indexes) {
      const subtask = subtasks[oldIndex];
      if (!subtask) continue;
      const explicitDeps = (subtask.depends_on ?? []).map((dep) =>
        remapDependency(dep, oldIndex, oldToNew, waveForOldIndex),
      );
      const newIndex = oldToNew.get(oldIndex);
      if (newIndex === undefined) {
        throw new PublishPlanError(
          'PLAN_INVALID_WAVE_DEPENDENCY',
          `wave ordering lost sub-task ${oldIndex}`,
        );
      }
      orderedSubtasks.push({
        ...subtask,
        depends_on: uniqueSorted([...explicitDeps, ...previousWaveIndexes]),
      });
      currentWaveIndexes.push(newIndex);
    }

    previousWaveIndexes = currentWaveIndexes;
  }

  return {
    subtasks: orderedSubtasks,
    waveNames: allWaves.map((wave, index) => wave.name ?? `Wave ${index + 1}`),
  };
}

function resolveWaveIndexes(
  waves: WaveInput[],
  subtasks: SubtaskInput[],
): Array<{ name?: string | undefined; indexes: number[] }> {
  const used = new Set<number>();
  return waves.map((wave, waveIndex) => {
    const indexes = uniqueInOrder(resolveWaveRefs(wave, subtasks));
    if (indexes.length === 0) {
      throw new PublishPlanError(
        'PLAN_INVALID_WAVE_DEPENDENCY',
        `wave ${waveIndex} does not reference any sub-tasks`,
      );
    }
    for (const index of indexes) {
      if (index < 0 || index >= subtasks.length) {
        throw new PublishPlanError(
          'PLAN_INVALID_WAVE_DEPENDENCY',
          `wave ${waveIndex} references sub-task ${index}; index is outside the plan`,
        );
      }
      if (used.has(index)) {
        throw new PublishPlanError(
          'PLAN_INVALID_WAVE_DEPENDENCY',
          `sub-task ${index} appears in more than one wave`,
        );
      }
      used.add(index);
    }
    return { name: wave.name ?? wave.title, indexes };
  });
}

function resolveWaveRefs(wave: WaveInput, subtasks: SubtaskInput[]): number[] {
  const indexes = wave.subtask_indexes ?? wave.subtask_indices ?? [];
  const byTitle = (wave.titles ?? []).map((title) => subtaskIndexByTitle(title, subtasks));
  const byRef = (wave.subtask_refs ?? []).flatMap((ref) => subtaskIndexesByRef(ref, subtasks));
  return [...indexes, ...byTitle, ...byRef];
}

function subtaskIndexByTitle(title: string, subtasks: SubtaskInput[]): number {
  const needle = title.trim().toLowerCase();
  const index = subtasks.findIndex((subtask) => subtask.title.trim().toLowerCase() === needle);
  if (index < 0) {
    throw new PublishPlanError(
      'PLAN_INVALID_WAVE_DEPENDENCY',
      `wave references unknown sub-task title '${title}'`,
    );
  }
  return index;
}

function subtaskIndexesByRef(ref: string, subtasks: SubtaskInput[]): number[] {
  const trimmed = ref.trim();
  const numeric = Number(trimmed);
  if (Number.isInteger(numeric) && numeric >= 0) return [numeric];

  const titleMatch = subtasks.findIndex(
    (subtask) => subtask.title.trim().toLowerCase() === trimmed.toLowerCase(),
  );
  if (titleMatch >= 0) return [titleMatch];

  const kind = trimmed
    .toLowerCase()
    .replace(/^kind:/, '')
    .replace(/^capability:/, '');
  const capability = capabilityFromRef(kind);
  if (capability) {
    return subtasks
      .map((subtask, index) => (subtask.capability_hint === capability ? index : -1))
      .filter((index) => index >= 0);
  }

  throw new PublishPlanError(
    'PLAN_INVALID_WAVE_DEPENDENCY',
    `wave references unknown sub-task ref '${ref}'`,
  );
}

function capabilityFromRef(ref: string): PublishPlanSubtaskInput['capability_hint'] | null {
  if (ref === 'api' || ref === 'api_work') return 'api_work';
  if (ref === 'ui' || ref === 'web' || ref === 'ui_work') return 'ui_work';
  if (ref === 'test' || ref === 'tests' || ref === 'test_work') return 'test_work';
  if (ref === 'infra' || ref === 'infrastructure' || ref === 'infra_work') return 'infra_work';
  if (ref === 'doc' || ref === 'docs' || ref === 'doc_work') return 'doc_work';
  return null;
}

function remapDependency(
  dependency: number,
  oldIndex: number,
  oldToNew: Map<number, number>,
  waveForOldIndex: Map<number, number>,
): number {
  const newDependency = oldToNew.get(dependency);
  const currentWave = waveForOldIndex.get(oldIndex);
  const dependencyWave = waveForOldIndex.get(dependency);
  if (newDependency === undefined || currentWave === undefined || dependencyWave === undefined) {
    throw new PublishPlanError(
      'PLAN_INVALID_WAVE_DEPENDENCY',
      `sub-task ${oldIndex} depends on unknown sub-task ${dependency}`,
    );
  }
  if (dependencyWave >= currentWave) {
    throw new PublishPlanError(
      'PLAN_INVALID_WAVE_DEPENDENCY',
      `sub-task ${oldIndex} depends on ${dependency}; wave dependencies must point to earlier waves`,
    );
  }
  return newDependency;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function uniqueInOrder(values: number[]): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

interface PreparedSpecRowCompletionDelta {
  path: string;
  previousContent: string;
  nextContent: string;
  specRowId: string;
  rowCells: string[];
}

function prepareSpecRowCompletionDelta(
  store: MemoryStore,
  args: {
    plan_slug: string;
    subtask: SubtaskInfo;
  },
): PreparedSpecRowCompletionDelta | null {
  const specRowId = args.subtask.spec_row_id;
  if (specRowId === null) return null;
  if (args.subtask.parent_spec_task_id === null) {
    throw new Error(
      `bound sub-task ${args.plan_slug}/${args.subtask.subtask_index} has no parent spec task`,
    );
  }

  const parentTask = store.storage
    .listTasks(2000)
    .find((task) => task.id === args.subtask.parent_spec_task_id);
  if (!parentTask) {
    throw new Error(`parent spec task ${args.subtask.parent_spec_task_id} not found`);
  }

  const repo = new SpecRepository({ repoRoot: parentTask.repo_root, store });
  const change = repo.readChange(args.plan_slug);
  const rowCells = completedSpecRowCells(repo.readRoot(), specRowId);
  change.deltaRows.push({
    op: 'modify',
    target: specRowId,
    row: { id: specRowId, cells: rowCells },
  });
  const path = specChangePath(parentTask.repo_root, args.plan_slug);
  return {
    path,
    previousContent: readFileSync(path, 'utf8'),
    nextContent: serializeChange(change),
    specRowId,
    rowCells,
  };
}

function writeFileAtomic(path: string, content: string): void {
  const tmpPath = join(
    dirname(path),
    `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  try {
    writeFileSync(tmpPath, content, 'utf8');
    renameSync(tmpPath, path);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup only
    }
    throw err;
  }
}

function revertSpecChange(delta: PreparedSpecRowCompletionDelta): void {
  try {
    writeFileAtomic(delta.path, delta.previousContent);
  } catch {
    // best-effort rollback only
  }
}

function specChangePath(repoRoot: string, slug: string): string {
  return join(repoRoot, 'openspec/changes', slug, 'CHANGE.md');
}

function restoreStagedArchive(repoRoot: string, slug: string): void {
  const changeDir = dirname(specChangePath(repoRoot, slug));
  const stagingPath = join(repoRoot, 'openspec/changes/archive', `.staging-${slug}`);
  if (existsSync(changeDir) || !existsSync(stagingPath)) return;
  try {
    renameSync(stagingPath, changeDir);
  } catch {
    // best-effort archive rollback only
  }
}

function completedSpecRowCells(spec: Spec, specRowId: string): string[] {
  const row =
    spec.sections.T.rows?.find((candidate) => candidate.id === specRowId) ??
    spec.sections.V.rows?.find((candidate) => candidate.id === specRowId) ??
    spec.sections.B.rows?.find((candidate) => candidate.id === specRowId);
  const cells = row ? [...row.cells] : [specRowId];
  cells[0] = specRowId;
  if (cells.length < 2) {
    cells.push('done');
  } else {
    cells[1] = 'done';
  }
  return cells;
}

interface AutoArchiveOutcome {
  status: 'archived' | 'blocked' | 'error' | 'skipped';
  reason?: string;
  archived_path?: string;
  merged_root_hash?: string;
  applied?: number;
  conflicts?: number;
}

/**
 * Grace window between the last sub-task completion and an opportunistic
 * auto-archive when the plan was published with `auto_archive: false`.
 * Short enough that a stale completed plan does not linger in health for
 * long, long enough that a follow-up `colony plan close` or human review
 * can land first if the lane wants explicit archival.
 */
const AUTO_ARCHIVE_GRACE_PERIOD_MS = 60_000;

function runAutoArchiveIfReady(
  store: MemoryStore,
  args: {
    plan_slug: string;
    parent_spec_task_id: number | null;
    session_id: string;
    now?: number;
  },
): AutoArchiveOutcome {
  if (args.parent_spec_task_id == null) {
    return { status: 'skipped', reason: 'no parent spec task linkage on sub-task' };
  }

  const config = readPlanConfig(store, args.parent_spec_task_id);

  // Aggregate sibling sub-task statuses. The core `readSubtask` helper
  // already resolves the claim/complete race with a terminal-state-wins
  // rule, so a freshly-completed sub-task surfaces as `completed` here
  // even when the prior `claimed` observation shares its millisecond
  // timestamp.
  const allTasks = store.storage.listTasks(2000);
  const siblingBranchPrefix = `spec/${args.plan_slug}/sub-`;
  const siblingTasks = allTasks.filter((t) => t.branch.startsWith(siblingBranchPrefix));
  const siblingInfos = siblingTasks
    .map((t) => readSubtaskByBranch(store, t.branch))
    .filter((s): s is SubtaskLookup => s !== null)
    .map((s) => s.info);
  if (siblingInfos.length === 0) {
    return { status: 'skipped', reason: 'no sub-tasks found' };
  }
  const allDone = siblingInfos.every((s) => s.status === 'completed');
  if (!allDone) {
    return { status: 'skipped', reason: 'sub-tasks still outstanding' };
  }

  // When auto_archive was not opted into at publish time, only fire after
  // a grace window elapses since the last sub-task completion. This lets
  // an operator land an explicit `colony plan close` (or refuse the
  // archive entirely) before the merge happens silently.
  if (!config?.auto_archive) {
    const now = args.now ?? Date.now();
    const latest = latestSubtaskCompletedAt(store, siblingTasks);
    if (latest === null) {
      return { status: 'skipped', reason: 'auto_archive disabled' };
    }
    if (now - latest < AUTO_ARCHIVE_GRACE_PERIOD_MS) {
      return {
        status: 'skipped',
        reason: 'auto_archive grace period pending',
      };
    }
  }

  const parentTask = allTasks.find((t) => t.id === args.parent_spec_task_id);
  if (!parentTask) {
    return { status: 'skipped', reason: 'parent spec task not found' };
  }

  // The parent spec task's `repo_root` may point to a now-deleted agent
  // worktree. Strip the managed-worktree segment so the sweep can keep
  // working when the lane was cleaned up.
  const usableRepoRoot = resolveUsableRepoRoot(parentTask.repo_root);
  if (!usableRepoRoot) {
    return { status: 'skipped', reason: 'parent repo path missing on disk' };
  }

  // The change directory may already be missing because the operator (or
  // an earlier sweep) moved it under `openspec/changes/archive/<date>-<slug>`
  // without leaving a `plan-archived` observation. Reconcile by recording
  // the archive path so the plan stops surfacing as completed-but-unarchived
  // forever.
  const sourceChangeDir = join(usableRepoRoot, 'openspec/changes', args.plan_slug);
  if (!existsSync(sourceChangeDir)) {
    const onDiskArchive = findExistingArchiveDir(usableRepoRoot, args.plan_slug);
    if (onDiskArchive) {
      store.addObservation({
        session_id: args.session_id,
        task_id: args.parent_spec_task_id,
        kind: 'plan-archived',
        content: `plan ${args.plan_slug} reconciled with on-disk archive`,
        metadata: {
          plan_slug: args.plan_slug,
          archived_path: onDiskArchive,
          reconciled: true,
        },
      });
      return { status: 'archived', archived_path: onDiskArchive };
    }
    return { status: 'skipped', reason: 'change directory missing and no archive found' };
  }

  try {
    const repo = new SpecRepository({ repoRoot: usableRepoRoot, store });
    const currentRoot = repo.readRoot();
    const change = repo.readChange(args.plan_slug);
    const baseRoot =
      currentRoot.rootHash === change.baseRootHash
        ? currentRoot
        : parseSpec(serializeSpec(currentRoot));
    const engine = new SyncEngine('three_way');
    const merge = engine.merge(currentRoot, baseRoot, change);

    if (!merge.clean) {
      const blockedObservationId = store.addObservation({
        session_id: args.session_id,
        task_id: args.parent_spec_task_id,
        kind: 'plan-archive-blocked',
        content: `plan ${args.plan_slug} ready to archive but ${merge.conflicts.length} conflict(s) block the merge`,
        metadata: {
          plan_slug: args.plan_slug,
          conflicts: merge.conflicts,
          applied: merge.applied,
        },
      });
      recordReflexion(store, {
        session_id: args.session_id,
        task_id: args.parent_spec_task_id,
        kind: 'failure',
        action: 'plan archive blocked',
        observation_summary: `plan ${args.plan_slug} archive blocked by ${merge.conflicts.length} conflict(s)`,
        reflection: 'plan archive conflicts need manual spec merge resolution',
        source_kind: 'plan-archive-blocked',
        source_observation_id: blockedObservationId,
        idempotency_key: `plan-archive-blocked:${args.plan_slug}:${merge.conflicts
          .map((conflict) => `${conflict.target}:${conflict.reason}`)
          .join(',')}`,
        reply_to: blockedObservationId,
        tags: ['plan', 'archive'],
      });
      return {
        status: 'blocked',
        reason: 'three-way merge conflicts',
        conflicts: merge.conflicts.length,
        applied: merge.applied,
      };
    }

    repo.writeRoot(merge.spec, {
      session_id: args.session_id,
      agent: 'plan-system',
      reason: `Auto-archive ${args.plan_slug}: all ${siblingInfos.length} sub-tasks completed`,
    });
    const archivedPath = repo.archiveChange(args.plan_slug);

    store.addObservation({
      session_id: args.session_id,
      task_id: args.parent_spec_task_id,
      kind: 'plan-archived',
      content: `plan ${args.plan_slug} auto-archived after all sub-tasks completed`,
      metadata: {
        plan_slug: args.plan_slug,
        archived_path: archivedPath,
        merged_root_hash: merge.spec.rootHash,
        applied: merge.applied,
      },
    });
    return {
      status: 'archived',
      archived_path: archivedPath,
      merged_root_hash: merge.spec.rootHash,
      applied: merge.applied,
      conflicts: 0,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    restoreStagedArchive(usableRepoRoot, args.plan_slug);
    store.addObservation({
      session_id: args.session_id,
      task_id: args.parent_spec_task_id,
      kind: 'plan-archive-error',
      content: `plan ${args.plan_slug} auto-archive failed: ${message}`,
      metadata: { plan_slug: args.plan_slug, error: message },
    });
    return { status: 'error', reason: message };
  }
}

/**
 * Resolve the parent spec task's `repo_root` to a directory that still
 * exists on disk. When the task was created inside an agent worktree
 * (`<root>/.omx/agent-worktrees/<lane>` or `.omc/...`), the lane may
 * have been pruned after merge — in that case we strip the worktree
 * segment to find the canonical repo. Returns null if no candidate
 * exists.
 */
function resolveUsableRepoRoot(repoRoot: string): string | null {
  if (existsSync(repoRoot)) return repoRoot;
  const stripped = resolveManagedRepoRoot(repoRoot);
  if (stripped !== repoRoot && existsSync(stripped)) return stripped;
  return null;
}

/**
 * Look for an `openspec/changes/archive/<date>-<slug>` directory under
 * the given repo root. Returns the absolute path of the first match,
 * or null if none exist. Used by the auto-archive sweep to reconcile
 * plans whose change directory was archived manually before colony
 * recorded a `plan-archived` observation.
 */
function findExistingArchiveDir(repoRoot: string, slug: string): string | null {
  const archiveRoot = join(repoRoot, 'openspec/changes/archive');
  if (!existsSync(archiveRoot)) return null;
  let entries: string[];
  try {
    entries = readdirSync(archiveRoot);
  } catch {
    return null;
  }
  const match = entries.find((name) => name.endsWith(`-${slug}`));
  return match ? join(archiveRoot, match) : null;
}

/**
 * Read-path sweep that archives completed plans past the grace window.
 * Bounded to current spec changes (cheap iteration over plan-config
 * observations) so list calls remain fast even when many plans linger.
 * Errors are swallowed: a failed archive surfaces via the
 * `plan-archive-blocked` / `plan-archive-error` observation already
 * written by `runAutoArchiveIfReady`, not via the list response.
 */
const PLAN_AUTO_ARCHIVE_SWEEP_SESSION = 'plan-auto-archive-sweep';

function sweepCompletedPlansForAutoArchive(store: MemoryStore, repo_root?: string): void {
  try {
    const plans = listPlans(store, {
      ...(repo_root !== undefined ? { repo_root } : {}),
      limit: 100,
    });
    let sessionEnsured = false;
    for (const plan of plans) {
      const counts = plan.subtask_counts;
      const total = counts.available + counts.claimed + counts.completed + counts.blocked;
      if (total === 0 || counts.completed !== total) continue;
      if (!sessionEnsured) {
        if (!store.storage.getSession(PLAN_AUTO_ARCHIVE_SWEEP_SESSION)) {
          store.startSession({
            id: PLAN_AUTO_ARCHIVE_SWEEP_SESSION,
            ide: 'plan-system',
            cwd: null,
            metadata: { source: 'plan-auto-archive-sweep' },
          });
        }
        sessionEnsured = true;
      }
      runAutoArchiveIfReady(store, {
        plan_slug: plan.plan_slug,
        parent_spec_task_id: plan.spec_task_id,
        session_id: PLAN_AUTO_ARCHIVE_SWEEP_SESSION,
      });
    }
  } catch {
    // Best-effort. The next list call will retry the sweep.
  }
}

function latestSubtaskCompletedAt(
  store: MemoryStore,
  siblingTasks: Array<{ id: number }>,
): number | null {
  let latest = Number.NEGATIVE_INFINITY;
  for (const task of siblingTasks) {
    const claims = store.storage.taskObservationsByKind(task.id, 'plan-subtask-claim', 100);
    for (const row of claims) {
      const parsed = parseMeta(row.metadata);
      if (parsed.status !== 'completed') continue;
      const ts =
        typeof parsed.completed_at === 'number' && Number.isFinite(parsed.completed_at)
          ? parsed.completed_at
          : row.ts;
      if (typeof ts === 'number' && ts > latest) latest = ts;
    }
  }
  return Number.isFinite(latest) ? latest : null;
}

function readPlanConfig(
  store: MemoryStore,
  parent_task_id: number,
): { auto_archive: boolean } | null {
  const rows = store.storage.taskObservationsByKind(parent_task_id, 'plan-config', 100);
  // taskObservationsByKind returns DESC by ts; latest config wins.
  const latest = rows[0];
  if (!latest?.metadata) return null;
  const parsed = parseMeta(latest.metadata);
  // parseMeta returns {} for malformed JSON; treat that the same as null (no config).
  if (Object.keys(parsed).length === 0) return null;
  return { auto_archive: Boolean(parsed.auto_archive) };
}

function readPlanSubtasks(store: MemoryStore, planSlug: string): SubtaskInfo[] {
  return store.storage
    .listTasks(2000)
    .filter((t) => {
      const m = t.branch.match(/^spec\/([a-z0-9-]+)\/sub-(\d+)$/);
      return Boolean(m && m[1] === planSlug);
    })
    .map((t) => readSubtaskByBranch(store, t.branch))
    .filter((s): s is SubtaskLookup => s !== null)
    .map((s) => s.info)
    .sort((a, b) => a.subtask_index - b.subtask_index);
}

function subtaskInfoToWorkspaceTask(
  subtask: SubtaskInfo,
  completion?: { completedSubtaskIndex: number; summary: string },
): PlanWorkspaceTaskInput {
  return {
    title: subtask.title,
    description: subtask.description,
    file_scope: subtask.file_scope,
    depends_on: subtask.depends_on,
    spec_row_id: subtask.spec_row_id,
    capability_hint: isPlanCapabilityHint(subtask.capability_hint) ? subtask.capability_hint : null,
    status: subtask.status,
    claimed_by_session_id: subtask.claimed_by_session_id,
    claimed_by_agent: subtask.claimed_by_agent,
    completed_summary:
      subtask.subtask_index === completion?.completedSubtaskIndex ? completion.summary : null,
  };
}

function isPlanCapabilityHint(
  value: string | null,
): value is NonNullable<PlanWorkspaceTaskInput['capability_hint']> {
  return (
    value === 'ui_work' ||
    value === 'api_work' ||
    value === 'test_work' ||
    value === 'infra_work' ||
    value === 'doc_work'
  );
}
