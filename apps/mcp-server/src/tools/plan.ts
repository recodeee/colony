import {
  type SubtaskInfo,
  TaskThread,
  areDepsMet,
  listPlans,
  readSubtaskByBranch,
} from '@colony/core';
import { SpecRepository } from '@colony/spec';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { mcpErrorResponse } from './shared.js';

const SubtaskInputSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  file_scope: z.array(z.string().min(1)).min(1),
  depends_on: z.array(z.number().int().nonnegative()).optional(),
  capability_hint: z
    .enum(['ui_work', 'api_work', 'test_work', 'infra_work', 'doc_work'])
    .optional(),
});

type SubtaskInput = z.infer<typeof SubtaskInputSchema>;

interface CodedError extends Error {
  __code?: string;
}

export function register(server: McpServer, ctx: ToolContext): void {
  const { store } = ctx;

  server.tool(
    'task_plan_publish',
    [
      'Publish a multi-task plan. Creates a spec change document at',
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
    },
    async (args) => {
      for (let i = 0; i < args.subtasks.length; i++) {
        const subtask = args.subtasks[i];
        if (!subtask) continue;
        for (const dep of subtask.depends_on ?? []) {
          if (dep >= i) {
            return mcpErrorResponse(
              'PLAN_INVALID_DEPENDENCY',
              `sub-task ${i} depends on ${dep}; dependencies must point to earlier indices (no cycles)`,
            );
          }
        }
      }

      const overlap = detectScopeOverlap(args.subtasks);
      if (overlap) {
        return mcpErrorResponse(
          'PLAN_SCOPE_OVERLAP',
          `sub-tasks ${overlap.a} and ${overlap.b} share files [${overlap.shared.join(', ')}] without a depends_on edge between them`,
        );
      }

      const repo = new SpecRepository({ repoRoot: args.repo_root, store });
      const proposal = renderProposal(args);
      const opened = repo.openChange({
        slug: args.slug,
        session_id: args.session_id,
        agent: args.agent,
        proposal,
      });

      const subtaskThreads = args.subtasks.map((subtask, index) => {
        const branch = `spec/${args.slug}/sub-${index}`;
        const thread = TaskThread.open(store, {
          repo_root: args.repo_root,
          branch,
          session_id: args.session_id,
        });
        store.addObservation({
          session_id: args.session_id,
          task_id: thread.task_id,
          kind: 'plan-subtask',
          content: `${subtask.title}\n\n${subtask.description}`,
          metadata: {
            parent_plan_slug: args.slug,
            parent_plan_title: args.title,
            parent_spec_task_id: opened.task_id,
            subtask_index: index,
            file_scope: subtask.file_scope,
            depends_on: subtask.depends_on ?? [],
            capability_hint: subtask.capability_hint ?? null,
            status: 'available',
          },
        });
        return {
          subtask_index: index,
          branch,
          task_id: thread.task_id,
          title: subtask.title,
        };
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              plan_slug: args.slug,
              spec_task_id: opened.task_id,
              spec_change_path: opened.path,
              subtasks: subtaskThreads,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    'task_plan_list',
    'List published plans. Returns plan-level rollup with sub-task counts by status (available/claimed/completed/blocked) and a next_available list of unblocked, unclaimed sub-tasks. Filter by repo_root, only_with_available_subtasks, or capability_match.',
    {
      repo_root: z.string().min(1).optional(),
      only_with_available_subtasks: z.boolean().optional(),
      capability_match: z
        .enum(['ui_work', 'api_work', 'test_work', 'infra_work', 'doc_work'])
        .optional(),
      limit: z.number().int().positive().max(50).optional(),
    },
    async (args) => {
      const plans = listPlans(store, {
        ...(args.repo_root !== undefined ? { repo_root: args.repo_root } : {}),
        ...(args.only_with_available_subtasks !== undefined
          ? { only_with_available_subtasks: args.only_with_available_subtasks }
          : {}),
        ...(args.capability_match !== undefined ? { capability_match: args.capability_match } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      return { content: [{ type: 'text', text: JSON.stringify(plans) }] };
    },
  );

  server.tool(
    'task_plan_claim_subtask',
    'Claim an available sub-task on a published plan. Joins you to the sub-task thread and activates file claims for the sub-task file_scope. Refuses if dependencies are not met or another agent already holds the claim.',
    {
      plan_slug: z.string().min(1),
      subtask_index: z.number().int().nonnegative(),
      session_id: z.string().min(1),
      agent: z.string().min(1),
    },
    async (args) => {
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
        .filter((s): s is { task_id: number; info: SubtaskInfo } => s !== null)
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
      // first commit wins, the second reads its claim row and rejects.
      try {
        store.storage.transaction(() => {
          const claimRows = store.storage.taskObservationsByKind(
            located.task_id,
            'plan-subtask-claim',
            500,
          );
          for (const row of claimRows) {
            const meta = parseRowMeta(row.metadata);
            if (meta.status === 'claimed' || meta.status === 'completed') {
              const err: CodedError = new Error(
                `sub-task is ${meta.status}${meta.session_id ? ` by ${meta.session_id}` : ''}`,
              );
              err.__code = 'PLAN_SUBTASK_NOT_AVAILABLE';
              throw err;
            }
          }
          store.addObservation({
            session_id: args.session_id,
            task_id: located.task_id,
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
          const thread = new TaskThread(store, located.task_id);
          thread.join(args.session_id, args.agent);
          for (const file of located.info.file_scope) {
            store.storage.claimFile({
              task_id: located.task_id,
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
        throw err;
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
    },
  );

  server.tool(
    'task_plan_complete_subtask',
    'Mark your claimed sub-task complete. Releases file claims; downstream sub-tasks (if any) become available.',
    {
      plan_slug: z.string().min(1),
      subtask_index: z.number().int().nonnegative(),
      session_id: z.string().min(1),
      summary: z.string().min(1).describe('What landed. Surfaces in the parent plan rollup.'),
    },
    async (args) => {
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
      });

      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'completed' }) }],
      };
    },
  );
}

function detectScopeOverlap(
  subtasks: SubtaskInput[],
): { a: number; b: number; shared: string[] } | null {
  for (let i = 0; i < subtasks.length; i++) {
    for (let j = i + 1; j < subtasks.length; j++) {
      const a = subtasks[i];
      const b = subtasks[j];
      if (!a || !b) continue;
      if (isDependentChain(subtasks, i, j) || isDependentChain(subtasks, j, i)) continue;
      const shared = a.file_scope.filter((f) => b.file_scope.includes(f));
      if (shared.length > 0) return { a: i, b: j, shared };
    }
  }
  return null;
}

function isDependentChain(subtasks: SubtaskInput[], from: number, to: number): boolean {
  const visited = new Set<number>();
  const stack = [from];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined || visited.has(cur)) continue;
    visited.add(cur);
    const deps = subtasks[cur]?.depends_on ?? [];
    if (deps.includes(to)) return true;
    stack.push(...deps);
  }
  return false;
}

function renderProposal(args: {
  title: string;
  problem: string;
  acceptance_criteria: string[];
  subtasks: SubtaskInput[];
}): string {
  const subtaskBlocks = args.subtasks
    .map((s, i) => {
      const deps = s.depends_on?.length ? ` (depends on: ${s.depends_on.join(', ')})` : '';
      return `### Sub-task ${i}: ${s.title}${deps}\n\n${s.description}\n\nFile scope: ${s.file_scope.join(', ')}`;
    })
    .join('\n\n');
  const criteria = args.acceptance_criteria.map((c) => `- ${c}`).join('\n');
  return `# ${args.title}\n\n## Problem\n\n${args.problem}\n\n## Acceptance criteria\n\n${criteria}\n\n## Sub-tasks\n\n${subtaskBlocks}\n`;
}

function parseRowMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
