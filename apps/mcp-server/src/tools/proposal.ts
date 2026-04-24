import { ProposalSystem } from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';

export function register(server: McpServer, ctx: ToolContext): void {
  const { store } = ctx;

  server.tool(
    'task_propose',
    'Propose a potential improvement scoped to (repo_root, branch). Becomes a real task only after collective reinforcement crosses the promotion threshold.',
    {
      repo_root: z.string().min(1),
      branch: z.string().min(1),
      summary: z.string().min(1),
      rationale: z.string().min(1),
      touches_files: z.array(z.string()).default([]),
      session_id: z.string().min(1),
    },
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
              promotion_threshold: ProposalSystem.PROMOTION_THRESHOLD,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    'task_reinforce',
    "Reinforce a pending proposal. kind='explicit' for direct support; 'rediscovered' when you arrived at the same idea independently.",
    {
      proposal_id: z.number().int().positive(),
      session_id: z.string().min(1),
      kind: z.enum(['explicit', 'rediscovered']).default('explicit'),
    },
    async ({ proposal_id, session_id, kind }) => {
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
    },
  );
}
