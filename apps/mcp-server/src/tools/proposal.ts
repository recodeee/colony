import { ProposalSystem } from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type ToolContext, defaultWrapHandler } from './context.js';

export function register(server: McpServer, ctx: ToolContext): void {
  const wrapHandler = ctx.wrapHandler ?? defaultWrapHandler;
  const { store } = ctx;

  server.tool(
    'task_propose',
    'Propose future work for a repo branch. Creates a candidate task with rationale, touched files, strength, and promotion threshold before claimable work appears.',
    {
      repo_root: z.string().min(1),
      branch: z.string().min(1),
      summary: z.string().min(1),
      rationale: z.string().min(1),
      touches_files: z.array(z.string()).default([]),
      session_id: z.string().min(1),
    },
    wrapHandler(
      'task_propose',
      async ({ repo_root, branch, summary, rationale, touches_files, session_id }) => {
        const proposals = new ProposalSystem(store);
        const id = proposals.propose({
          repo_root,
          branch,
          summary,
          rationale,
          touches_files,
          session_id,
        });
        const strength = proposals.currentStrength(id);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                proposal_id: id,
                strength,
                promotion_threshold: proposals.promotionThreshold,
              }),
            },
          ],
        };
      },
    ),
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
