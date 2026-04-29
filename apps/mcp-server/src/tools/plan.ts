import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type MemoryStore,
  type SubtaskInfo,
  type SubtaskLookup,
  TaskThread,
  areDepsMet,
  findSubtaskBySpecRow,
  listPlans,
  readSubtaskByBranch,
} from '@colony/core';
import {
  type PlanWorkspaceTaskInput,
  PublishPlanError,
  type PublishPlanSubtaskInput,
  type Spec,
  SpecRepository,
  SyncEngine,
  parseSpec,
  publishPlan,
  serializeChange,
  serializeSpec,
  syncPlanWorkspaceTasks,
} from '@colony/spec';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type ToolContext, defaultWrapHandler } from './context.js';
import { withPlanPublishGuidance } from './plan-output.js';
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
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                withPlanPublishGuidance(result, ordered.subtasks, {
                  wave_names: ordered.waveNames,
                }),
              ),
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
    'Find available plan sub-tasks, rollups, or next work. Lists published plans with status counts, next_available work, capability_match, and unclaimed routing.',
    {
      repo_root: z.string().min(1).optional(),
      only_with_available_subtasks: z.boolean().optional(),
      capability_match: z
        .enum(['ui_work', 'api_work', 'test_work', 'infra_work', 'doc_work'])
        .optional(),
      limit: z.number().int().positive().max(50).optional(),
    },
    wrapHandler('task_plan_list', async (args) => {
      const plans = listPlans(store, {
        ...(args.repo_root !== undefined ? { repo_root: args.repo_root } : {}),
        ...(args.only_with_available_subtasks !== undefined
          ? { only_with_available_subtasks: args.only_with_available_subtasks }
          : {}),
        ...(args.capability_match !== undefined ? { capability_match: args.capability_match } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      return { content: [{ type: 'text', text: JSON.stringify(plans) }] };
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
      const branch = `spec/${args.plan_slug}/sub-${args.subtask_index}`;
      const located = readSubtaskByBranch(store, branch);
      if (!located) {
        return mcpErrorResponse('PLAN_SUBTASK_NOT_FOUND', `no sub-task at ${branch}`);
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
        return mcpErrorResponse(
          'PLAN_SUBTASK_DEPS_UNMET',
          `dependencies not met: sub-tasks [${unmet.join(', ')}] are not completed`,
        );
      }

      // Race-safe claim. Re-scan the claim observations inside a transaction
      // so two concurrent claims serialize through SQLite's write lock; the
      // first commit wins, the second reads its current lifecycle and rejects.
      try {
        store.storage.transaction(() => {
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
            store.storage.claimFile({
              task_id: fresh.task_id,
              file_path: file,
              session_id: args.session_id,
            });
          }
        });
      } catch (err) {
        const code = (err as CodedError).__code;
        if (code === 'PLAN_SUBTASK_NOT_AVAILABLE') {
          return mcpErrorResponse(code, (err as Error).message);
        }
        return mcpError(err);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              task_id: located.task_id,
              branch,
              file_scope: located.info.file_scope,
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

function runAutoArchiveIfReady(
  store: MemoryStore,
  args: {
    plan_slug: string;
    parent_spec_task_id: number | null;
    session_id: string;
  },
): AutoArchiveOutcome {
  if (args.parent_spec_task_id == null) {
    return { status: 'skipped', reason: 'no parent spec task linkage on sub-task' };
  }

  const config = readPlanConfig(store, args.parent_spec_task_id);
  if (!config?.auto_archive) {
    return { status: 'skipped', reason: 'auto_archive disabled' };
  }

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

  const parentTask = allTasks.find((t) => t.id === args.parent_spec_task_id);
  if (!parentTask) {
    return { status: 'skipped', reason: 'parent spec task not found' };
  }

  try {
    const repo = new SpecRepository({ repoRoot: parentTask.repo_root, store });
    const currentRoot = repo.readRoot();
    const change = repo.readChange(args.plan_slug);
    const baseRoot =
      currentRoot.rootHash === change.baseRootHash
        ? currentRoot
        : parseSpec(serializeSpec(currentRoot));
    const engine = new SyncEngine('three_way');
    const merge = engine.merge(currentRoot, baseRoot, change);

    if (!merge.clean) {
      store.addObservation({
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
    restoreStagedArchive(parentTask.repo_root, args.plan_slug);
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

function readPlanConfig(
  store: MemoryStore,
  parent_task_id: number,
): { auto_archive: boolean } | null {
  const rows = store.storage.taskObservationsByKind(parent_task_id, 'plan-config', 100);
  // taskObservationsByKind returns DESC by ts; latest config wins.
  const latest = rows[0];
  if (!latest?.metadata) return null;
  try {
    const parsed = JSON.parse(latest.metadata) as { auto_archive?: unknown };
    return { auto_archive: Boolean(parsed.auto_archive) };
  } catch {
    return null;
  }
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
