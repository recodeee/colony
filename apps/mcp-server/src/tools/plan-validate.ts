import { dirname } from 'node:path/posix';
import type { MemoryStore } from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';

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

type SubtaskInput = z.infer<typeof SubtaskInputSchema>;

interface PairwiseOverlap {
  a: number;
  b: number;
  shared: string[];
}

interface LiveClaimCollision {
  subtask_index: number;
  file_path: string;
  holder_session_id: string;
  holder_task_id: number;
  holder_branch: string;
  claimed_at: number;
}

interface ModuleWarning {
  a: number;
  b: number;
  shared_modules: string[];
}

interface LiveClaim {
  task_id: number;
  file_path: string;
  session_id: string;
  claimed_at: number;
  branch: string;
}

export function register(server: McpServer, ctx: ToolContext): void {
  const { store } = ctx;

  server.tool(
    'task_plan_validate',
    'Check a multi-agent plan for file conflicts before publishing. Returns live claim collisions and pairwise overlaps between independent sub-tasks.',
    {
      repo_root: z.string().min(1),
      subtasks: z.array(SubtaskInputSchema).min(2).max(20),
    },
    async ({ repo_root, subtasks }) => {
      const pairwise = pairwiseScopeOverlap(subtasks);
      const liveCollisions = liveClaimCollisions(store, repo_root, subtasks);
      const moduleWarnings = computeModuleOverlaps(subtasks);

      return jsonReply({
        pairwise_overlaps: pairwise,
        live_claim_collisions: liveCollisions,
        module_warnings: moduleWarnings,
        partition_clean: pairwise.length === 0 && liveCollisions.length === 0,
      });
    },
  );
}

function jsonReply(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function pairwiseScopeOverlap(subtasks: SubtaskInput[]): PairwiseOverlap[] {
  const overlaps: PairwiseOverlap[] = [];
  for (let i = 0; i < subtasks.length; i++) {
    for (let j = i + 1; j < subtasks.length; j++) {
      const a = subtasks[i];
      const b = subtasks[j];
      if (!a || !b) continue;
      if (isDependentChain(subtasks, i, j) || isDependentChain(subtasks, j, i)) continue;

      const shared = intersect(a.file_scope, b.file_scope);
      if (shared.length > 0) overlaps.push({ a: i, b: j, shared });
    }
  }
  return overlaps;
}

function liveClaimCollisions(
  store: MemoryStore,
  repoRoot: string,
  subtasks: SubtaskInput[],
): LiveClaimCollision[] {
  const paths = [...new Set(subtasks.flatMap((subtask) => subtask.file_scope))];
  const claims = claimsForPaths(store, repoRoot, paths);
  const collisions: LiveClaimCollision[] = [];

  for (let subtaskIndex = 0; subtaskIndex < subtasks.length; subtaskIndex++) {
    const subtask = subtasks[subtaskIndex];
    if (!subtask) continue;
    for (const filePath of subtask.file_scope) {
      for (const claim of claims.filter((candidate) => candidate.file_path === filePath)) {
        collisions.push({
          subtask_index: subtaskIndex,
          file_path: filePath,
          holder_session_id: claim.session_id,
          holder_task_id: claim.task_id,
          holder_branch: claim.branch,
          claimed_at: claim.claimed_at,
        });
      }
    }
  }

  return collisions;
}

function claimsForPaths(store: MemoryStore, repoRoot: string, paths: string[]): LiveClaim[] {
  const wanted = new Set(paths);
  const rows: LiveClaim[] = [];
  for (const task of store.storage.listTasks(2000)) {
    if (task.repo_root !== repoRoot) continue;
    for (const claim of store.storage.listClaims(task.id)) {
      if (wanted.has(claim.file_path)) rows.push({ ...claim, branch: task.branch });
    }
  }
  return rows;
}

function computeModuleOverlaps(subtasks: SubtaskInput[]): ModuleWarning[] {
  const warnings: ModuleWarning[] = [];
  for (let i = 0; i < subtasks.length; i++) {
    for (let j = i + 1; j < subtasks.length; j++) {
      const a = subtasks[i];
      const b = subtasks[j];
      if (!a || !b) continue;
      if (isDependentChain(subtasks, i, j) || isDependentChain(subtasks, j, i)) continue;
      if (intersect(a.file_scope, b.file_scope).length > 0) continue;

      const sharedModules = intersect(moduleRoots(a.file_scope), moduleRoots(b.file_scope));
      if (sharedModules.length > 0) warnings.push({ a: i, b: j, shared_modules: sharedModules });
    }
  }
  return warnings;
}

function moduleRoots(paths: string[]): string[] {
  const roots = paths
    .map((path) => {
      const segments = normalizePath(path).split('/').filter(Boolean);
      if (segments.length >= 3) return segments.slice(0, 3).join('/');
      return dirname(segments.join('/'));
    })
    .filter((root) => root.length > 0 && root !== '.');
  return [...new Set(roots)];
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

function intersect(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return [...new Set(left.filter((value) => rightSet.has(value)))];
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}
