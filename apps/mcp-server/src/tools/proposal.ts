import { ProposalSystem } from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  type ProposalHandlerContext,
  handleTaskApproveProposal,
  handleTaskPropose,
} from '../handlers/proposals.js';
import { type ToolContext, defaultWrapHandler } from './context.js';

export function register(server: McpServer, ctx: ToolContext): void {
  const wrapHandler = ctx.wrapHandler ?? defaultWrapHandler;
  const { store } = ctx;

  server.tool(
    'task_propose',
    'Create an observation-backed scout proposal task. Scouts must include evidence IDs; executors must wait for task_approve_proposal before claiming proposed work.',
    {
      repo_root: z.string().min(1),
      branch: z.string().min(1),
      summary: z.string().min(1),
      rationale: z.string().min(1),
      touches_files: z.array(z.string()).default([]),
      observation_evidence_ids: z.array(z.number().int().positive()).default([]),
      session_id: z.string().min(1),
      agent: z.string().min(1).optional(),
    },
    wrapHandler(
      'task_propose',
      async ({
        repo_root,
        branch,
        summary,
        rationale,
        touches_files,
        observation_evidence_ids,
        session_id,
        agent,
      }) => {
        try {
          const result = handleTaskPropose(
            store,
            proposalContext(agent ?? session_id, session_id),
            {
              repo_root,
              branch,
              summary,
              rationale,
              touches_files,
              observationEvidenceIds: observation_evidence_ids,
            },
          );
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (err) {
          return proposalError(err);
        }
      },
    ),
  );

  server.tool(
    'task_approve_proposal',
    'Approve an observation-backed scout proposal task. Queen or operator agents flip proposal_status to approved and decrement the scout open-proposal count.',
    {
      task_id: z.number().int().positive(),
      session_id: z.string().min(1).optional(),
      agent: z.string().min(1),
    },
    wrapHandler('task_approve_proposal', async ({ task_id, session_id, agent }) => {
      try {
        const result = handleTaskApproveProposal(
          store,
          proposalContext(agent, session_id ?? agent),
          {
            taskId: task_id,
          },
        );
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        return proposalError(err);
      }
    }),
  );

  server.tool(
    'task_reinforce',
    "Support a proposed task so it can become claimable work. kind='explicit' means direct support; 'rediscovered' means independent rediscovery toward promotion.",
    {
      proposal_id: z.number().int().positive(),
      session_id: z.string().min(1),
      kind: z.enum(['explicit', 'rediscovered']).default('explicit'),
    },
    wrapHandler('task_reinforce', async ({ proposal_id, session_id, kind }) => {
      const proposals = new ProposalSystem(store);
      const { strength, promoted } = proposals.reinforce({
        proposal_id,
        session_id,
        kind,
      });
      const proposal = store.storage.getProposal(proposal_id);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              proposal_id,
              strength,
              promoted,
              task_id: proposal?.task_id ?? null,
            }),
          },
        ],
      };
    }),
  );
}

function proposalContext(agent: string, session_id: string): ProposalHandlerContext {
  return { agent, session_id };
}

function proposalError(err: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  const code =
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code?: unknown }).code === 'string'
      ? (err as { code: string }).code
      : 'INTERNAL_ERROR';
  const error = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text', text: JSON.stringify({ code, error }) }],
    isError: true,
  };
}
