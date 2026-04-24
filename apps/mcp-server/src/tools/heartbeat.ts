import { type HookInput, type HookName, upsertActiveSession } from '@colony/hooks';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

interface McpClientIdentity {
  sessionId: string;
  ide: string;
}

function detectMcpClientIdentity(env: NodeJS.ProcessEnv = process.env): McpClientIdentity {
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
  const client = detectMcpClientIdentity();
  const cwd = process.cwd();

  const touch = (hook: HookName, extras: Partial<HookInput> = {}): void => {
    try {
      upsertActiveSession({ session_id: client.sessionId, ide: client.ide, cwd, ...extras }, hook);
    } catch {
      // Heartbeat is best-effort; never fail a tool call because the JSON
      // sidecar cannot be written.
    }
  };

  // Register the client the moment the server is built — before any tool
  // call — so the lane is visible on the very first hivemind query.
  touch('session-start', { source: 'mcp-connect' });

  // Wrap every subsequent `server.tool(...)` registration so each invocation
  // bumps lastHeartbeatAt and reports the invoked tool name as the current
  // task preview. The SDK overloads this method; we only care that the last
  // argument is the handler.
  type ToolRegister = McpServer['tool'];
  const originalTool = server.tool.bind(server) as ToolRegister;
  (server as { tool: ToolRegister }).tool = ((...toolArgs: unknown[]) => {
    const name = typeof toolArgs[0] === 'string' ? toolArgs[0] : 'unknown';
    const handlerIndex = toolArgs.length - 1;
    const handler = toolArgs[handlerIndex];
    if (typeof handler === 'function') {
      const original = handler as (...handlerArgs: unknown[]) => unknown;
      toolArgs[handlerIndex] = async (...handlerArgs: unknown[]) => {
        touch('post-tool-use', { tool_name: `colony.${name}` });
        return original(...handlerArgs);
      };
    }
    return (originalTool as (...a: unknown[]) => ReturnType<ToolRegister>)(...toolArgs);
  }) as ToolRegister;
}
