import {
  type AgentCapabilities,
  DEFAULT_CAPABILITIES,
  loadProfile,
  saveProfile,
} from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type ToolContext, defaultWrapHandler } from './context.js';

export function register(server: McpServer, ctx: ToolContext): void {
  const wrapHandler = ctx.wrapHandler ?? defaultWrapHandler;
  const { store } = ctx;

  server.tool(
    'agent_upsert_profile',
    'Set an agent skill profile for routing handoffs or ready work. Capability weights cover ui_work, api_work, test_work, infra_work, and doc_work; missing weights stay unchanged.',
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
    wrapHandler('agent_upsert_profile', async ({ agent, capabilities }) => {
      const definedCapabilities = Object.fromEntries(
        Object.entries(capabilities).filter(([, value]) => value !== undefined),
      ) as Partial<AgentCapabilities>;
      const profile = saveProfile(store.storage, agent, definedCapabilities);
      return { content: [{ type: 'text', text: JSON.stringify(profile) }] };
    }),
  );

  server.tool(
    'agent_get_profile',
    'Read an agent skill profile for routing or fit checks. Unknown agents return default 0.5 capability weights for handoff and ready-work ranking.',
    { agent: z.string().min(1) },
    wrapHandler('agent_get_profile', async ({ agent }) => {
      const profile = loadProfile(store.storage, agent);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ...profile, defaults: DEFAULT_CAPABILITIES }),
          },
        ],
      };
    }),
  );
}
