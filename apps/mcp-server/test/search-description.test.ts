import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/tools/context.js';
import { register } from '../src/tools/search.js';

describe('search tool description', () => {
  it('teaches query-rich search before hydrating observations', () => {
    const tools: Array<{ description: string; name: string }> = [];
    const server = {
      tool: (...args: unknown[]) => {
        tools.push({ name: String(args[0]), description: String(args[1]) });
      },
    } as unknown as McpServer;
    const ctx = {
      store: {},
      settings: {},
      resolveEmbedder: async () => null,
    } as unknown as ToolContext;

    register(server, ctx);

    const search = tools.find((tool) => tool.name === 'search');
    expect(search?.description).toMatch(
      /^Search prior memory for decisions, errors, notes, files, and implementation context\./,
    );
    expect(search?.description).toContain(
      'feature name, package name, file path, task slug, or exact error message',
    );
    expect(search?.description).toContain('compact hits');
    expect(search?.description).toContain('get_observations');
  });
});
