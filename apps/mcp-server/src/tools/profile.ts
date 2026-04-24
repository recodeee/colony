import { type AgentCapabilities, DEFAULT_CAPABILITIES, loadProfile, saveProfile } from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';

export function register(server: McpServer, ctx: ToolContext): void {
  const { store } = ctx;

  server.tool(
    'agent_upsert_profile',
    "Set or update an agent's capability profile (ui_work, api_work, test_work, infra_work, doc_work). Weights are 0..1; missing weights keep their current value (or the 0.5 default for first-time profiles). Used by the handoff router to suggest which agent is the best fit for a broadcast ('any') handoff.",
    {
      agent: z.string().min(1),
      capabilities: z
        .object({
          ui_work: z.number().min(0).max(1).optional(),
          api_work: z.number().min(0).max(1).optional(),
          test_work: z.number().min(0).max(1).optional(),
          infra_work: z.number().min(0).max(1).optional(),
          doc_work: z.number().min(0).max(1).optional(),
        })
        .default({}),
    },
    async ({ agent, capabilities }) => {
      const definedCapabilities = Object.fromEntries(
        Object.entries(capabilities).filter(([, value]) => value !== undefined),
      ) as Partial<AgentCapabilities>;
      const profile = saveProfile(store.storage, agent, definedCapabilities);
      return { content: [{ type: 'text', text: JSON.stringify(profile) }] };
    },
  );

  server.tool(
    'agent_get_profile',
    'Read an agent capability profile. Unknown agents return the default (0.5 across all dimensions).',
    { agent: z.string().min(1) },
    async ({ agent }) => {
      const profile = loadProfile(store.storage, agent);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ...profile, defaults: DEFAULT_CAPABILITIES }),
          },
        ],
      };
    },
  );
}
