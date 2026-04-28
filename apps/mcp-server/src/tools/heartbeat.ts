import { type HookInput, type HookName, upsertActiveSession } from '@colony/hooks';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolHandlerWrapper } from './context.js';

export interface McpClientIdentity {
  sessionId: string;
  ide: string;
}

export function detectMcpClientIdentity(env: NodeJS.ProcessEnv = process.env): McpClientIdentity {
  const codexId = env.CODEX_SESSION_ID?.trim();
  if (codexId) return { sessionId: codexId, ide: 'codex' };
  const claudeId = env.CLAUDECODE_SESSION_ID?.trim() ?? env.CLAUDE_SESSION_ID?.trim();
  if (claudeId) return { sessionId: claudeId, ide: 'claude-code' };
  const override = env.COLONY_CLIENT_SESSION_ID?.trim();
  if (override) return { sessionId: override, ide: env.COLONY_CLIENT_IDE?.trim() ?? 'unknown' };
  // Fallback: stable per parent-process so the lane coalesces across tool calls.
  return { sessionId: `mcp-${process.ppid}`, ide: env.COLONY_CLIENT_IDE?.trim() ?? 'unknown' };
}

export function installActiveSessionHeartbeat(server: McpServer): void {
  // Register the client the moment the server is built — before any tool
  // call — so the lane is visible on the very first hivemind query.
  void server;
  touchActiveSession('session-start', { source: 'mcp-connect' });
}

export const wrapHandler: ToolHandlerWrapper = (name, handler) => {
  return ((...handlerArgs) => {
    touchActiveSession('post-tool-use', { tool_name: `colony.${name}` });
    return handler(...handlerArgs);
  }) as typeof handler;
};

function touchActiveSession(hook: HookName, extras: Partial<HookInput> = {}): void {
  const client = detectMcpClientIdentity();
  const cwd = process.cwd();
  try {
    upsertActiveSession({ session_id: client.sessionId, ide: client.ide, cwd, ...extras }, hook);
  } catch {
    // Heartbeat is best-effort; never fail a tool call because the JSON sidecar cannot be written.
  }
}
