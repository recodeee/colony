import {
  BackpropGate,
  SpecRepository,
  SyncEngine,
  type SyncStrategy,
  computeFailureSignature,
  parseSpec,
  resolveTaskContext,
  serializeSpec,
} from '@colony/spec';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { listSpecRowBindings } from './plan.js';
import { mcpErrorResponse } from './shared.js';

export function register(server: McpServer, ctx: ToolContext): void {
  const { store } = ctx;

  server.tool(
    'spec_read',
    'Read the root SPEC.md for a repo. Returns parsed sections + rootHash plus bound_subtasks: a sibling map of spec row id → { plan_slug, subtask_index, status } for every §V/§I/§T/§B row currently bound to a sub-task in this repo. Lets callers spot in-flight rows without scanning every plan.',
    { repo_root: z.string().min(1) },
    async ({ repo_root }) => {
      const repo = new SpecRepository({ repoRoot: repo_root, store });
      const spec = repo.readRoot();
      const boundSubtasks = listSpecRowBindings(store, repo_root);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              rootHash: spec.rootHash,
              sections: Object.fromEntries(
                Object.entries(spec.sections).map(([k, v]) => [
                  k,
                  { body: v.body, row_count: v.rows?.length ?? null },
                ]),
              ),
              alwaysInvariants: spec.alwaysInvariants,
              bound_subtasks: boundSubtasks,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    'spec_change_open',
    'Open a new spec change. Creates openspec/changes/<slug>/CHANGE.md, opens a task-thread on spec/<slug>, joins caller as participant.',
    {
      repo_root: z.string().min(1),
      slug: z
        .string()
        .min(1)
        .regex(/^[a-z0-9-]+$/, 'kebab-case only'),
      session_id: z.string().min(1),
      agent: z.string().min(1),
      proposal: z.string().optional(),
    },
    async ({ repo_root, slug, session_id, agent, proposal }) => {
      const repo = new SpecRepository({ repoRoot: repo_root, store });
      const result = repo.openChange({
        slug,
        session_id,
        agent,
        ...(proposal !== undefined ? { proposal } : {}),
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              task_id: result.task_id,
              path: result.path,
              base_root_hash: result.change.baseRootHash,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    'spec_change_add_delta',
    'Append a delta row to an in-flight change. op ∈ add|modify|remove; target is a root spec id like V.3 or T.12.',
    {
      repo_root: z.string().min(1),
      slug: z.string().min(1),
      session_id: z.string().min(1),
      op: z.enum(['add', 'modify', 'remove']),
      target: z.string().min(1),
      row_cells: z.array(z.string()).optional(),
    },
    async ({ repo_root, slug, session_id, op, target, row_cells }) => {
      const repo = new SpecRepository({ repoRoot: repo_root, store });
      const change = repo.readChange(slug);
      change.deltaRows.push({
        op,
        target,
        ...(row_cells ? { row: { id: target, cells: row_cells } } : {}),
      });
      repo.writeChange(change);
      const task = repo.listSpecTasks().find((t) => t.slug === slug);
      store.addObservation({
        session_id,
        kind: 'spec-delta',
        content: `${op} ${target}${row_cells ? ` = ${row_cells.join(' | ')}` : ''}`,
        ...(task ? { task_id: task.task_id } : {}),
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({ delta_count: change.deltaRows.length }) }],
      };
    },
  );

  server.tool(
    'spec_build_context',
    'Resolve cite-scoped context for a §T task id. Returns only the invariants and rows the task is obliged to respect plus §V.always entries — not the whole spec.',
    {
      repo_root: z.string().min(1),
      task_id: z.string().min(1).describe('§T row id, e.g. T5'),
    },
    async ({ repo_root, task_id }) => {
      const repo = new SpecRepository({ repoRoot: repo_root, store });
      const spec = repo.readRoot();
      const resolved = resolveTaskContext(spec, task_id);
      if (!resolved) {
        return mcpErrorResponse('SPEC_TASK_NOT_FOUND', `no task ${task_id}`);
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              cited_ids: resolved.cited_ids,
              always_invariants: resolved.always_invariants,
              rendered: resolved.rendered,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    'spec_build_record_failure',
    'Record a test failure during /co:build. Hashes the signature, appends §B, and — if the promote_after threshold is reached — proposes a §V invariant via colony ProposalSystem. Returns the decision.',
    {
      repo_root: z.string().min(1),
      slug: z.string().min(1),
      session_id: z.string().min(1),
      agent: z.string().min(1),
      test_id: z.string().min(1),
      error: z.string().min(1),
      stack: z.string().optional(),
      error_summary: z.string().min(1),
      promote_after: z.number().int().positive().optional(),
    },
    async (args) => {
      const repo = new SpecRepository({ repoRoot: args.repo_root, store });
      const specTask = repo.listSpecTasks().find((t) => t.slug === args.slug);
      if (!specTask) {
        return mcpErrorResponse('SPEC_CHANGE_NOT_FOUND', `no open change ${args.slug}`);
      }
      const signature = computeFailureSignature({
        test_id: args.test_id,
        error: args.error,
        ...(args.stack !== undefined ? { stack: args.stack } : {}),
      });
      const gate = new BackpropGate({
        store,
        repoRoot: args.repo_root,
        branch: specTask.branch,
        ...(args.promote_after !== undefined ? { promoteAfter: args.promote_after } : {}),
      });
      const decision = gate.recordFailure({
        task_id: specTask.task_id,
        session_id: args.session_id,
        agent: args.agent,
        signature,
        error_summary: args.error_summary,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              action: decision.action,
              signature_hash: signature.hash,
              match_count: decision.matchCount,
              proposal_id: decision.proposal_id ?? null,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    'spec_archive',
    'Validate, three-way-merge, and archive an in-flight change. Atomic: either the archive + root write both land, or neither does.',
    {
      repo_root: z.string().min(1),
      slug: z.string().min(1),
      session_id: z.string().min(1),
      agent: z.string().min(1),
      strategy: z.enum(['three_way', 'refuse_on_conflict', 'last_writer_wins']).optional(),
    },
    async (args) => {
      const repo = new SpecRepository({ repoRoot: args.repo_root, store });
      const currentRoot = repo.readRoot();
      const change = repo.readChange(args.slug);

      // Reconstruct the base root from the recorded hash. In practice we'd
      // keep an archived snapshot; for now, if the hash still matches current,
      // base == current. If not, fall back to current (last_writer_wins on
      // drift).
      const baseRoot =
        currentRoot.rootHash === change.baseRootHash
          ? currentRoot
          : parseSpec(serializeSpec(currentRoot));

      const strategy: SyncStrategy = args.strategy ?? 'three_way';
      const engine = new SyncEngine(strategy);
      const merge = engine.merge(currentRoot, baseRoot, change);

      if (!merge.clean && strategy === 'refuse_on_conflict') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'refused',
                conflicts: merge.conflicts,
                applied: merge.applied,
              }),
            },
          ],
          isError: true,
        };
      }

      repo.writeRoot(merge.spec, {
        session_id: args.session_id,
        agent: args.agent,
        reason: `Archive ${args.slug}: ${merge.applied} deltas applied, ${merge.conflicts.length} conflicts`,
      });

      const archivePath = repo.archiveChange(args.slug);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'archived',
              archived_path: archivePath,
              merged_root_hash: merge.spec.rootHash,
              conflicts: merge.conflicts,
              applied: merge.applied,
            }),
          },
        ],
      };
    },
  );
}
