import type { Settings } from '@colony/config';
import {
  type MemoryStore,
  detectRepoBranch,
  inferIdeFromSessionId,
  reconcileOmxActiveSessions,
} from '@colony/core';
import { type HookInput, type HookName, upsertActiveSession } from '@colony/hooks';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolHandlerWrapper } from './context.js';

export interface McpClientIdentity {
  sessionId: string;
  ide: string;
  inferred_agent: string;
  confidence: number;
  source: string;
}

interface HeartbeatOptions {
  activeSessionReconcileMinIntervalMs?: number;
  forceReconcile?: boolean;
  now?: () => number;
}

const DEFAULT_RECONCILE_MIN_INTERVAL_MS = 5_000;
const lastReconcileAtByRepoRoot = new Map<string, number>();

export function detectMcpClientIdentity(
  env: NodeJS.ProcessEnv = process.env,
  toolArgs?: unknown,
): McpClientIdentity {
  const args = recordValue(toolArgs);
  const explicitSession = readString(args?.session_id);
  const explicitAgent = readString(args?.agent);
  if (explicitSession && explicitAgent) {
    return identity(explicitSession, explicitAgent, 0.95, 'mcp-tool-caller:agent');
  }

  const codexId = env.CODEX_SESSION_ID?.trim();
  if (codexId) return identity(codexId, 'codex', 1, 'process-env:CODEX_SESSION_ID');
  const claudeId = env.CLAUDECODE_SESSION_ID?.trim() ?? env.CLAUDE_SESSION_ID?.trim();
  if (claudeId) return identity(claudeId, 'claude', 1, 'process-env:CLAUDECODE_SESSION_ID');
  const override = env.COLONY_CLIENT_SESSION_ID?.trim();
  if (override) {
    return identity(
      override,
      env.COLONY_CLIENT_IDE?.trim() ?? env.COLONY_CLIENT_AGENT?.trim() ?? '',
      0.9,
      'process-env:COLONY_CLIENT_SESSION_ID',
    );
  }

  if (explicitSession) {
    return identityFromSessionId(explicitSession, 'mcp-tool-caller:session_id');
  }
  const branchAgent = agentFromBranch(readString(args?.branch));
  if (branchAgent) {
    return identity(`mcp-${process.ppid}`, branchAgent, 0.7, 'mcp-tool-caller:branch');
  }
  const worktreeAgent = agentFromWorktreePath(readString(args?.cwd) || readString(args?.repo_root));
  if (worktreeAgent) {
    return identity(`mcp-${process.ppid}`, worktreeAgent, 0.65, 'mcp-tool-caller:worktree-path');
  }

  // Fallback: stable per parent-process so the lane coalesces across tool calls.
  return identity(`mcp-${process.ppid}`, '', 0, 'unbound');
}

export function installActiveSessionHeartbeat(
  server: McpServer,
  store?: MemoryStore,
  settings?: Settings,
): void {
  // Register the client the moment the server is built — before any tool
  // call — so the lane is visible on the very first hivemind query.
  void server;
  touchActiveSession('session-start', { source: 'mcp-connect' }, store, undefined, {
    ...heartbeatOptionsFromSettings(settings),
    forceReconcile: true,
  });
}

export function createHeartbeatWrapper(
  store?: MemoryStore,
  settings?: Settings,
): ToolHandlerWrapper {
  const options = heartbeatOptionsFromSettings(settings);
  return (name, handler) => {
    return ((...handlerArgs) => {
      const toolArgs = handlerArgs[0];
      touchActiveSession(
        'post-tool-use',
        { tool_name: `colony.${name}`, tool_input: toolArgs },
        store,
        toolArgs,
        options,
      );
      return handler(...handlerArgs);
    }) as typeof handler;
  };
}

export const wrapHandler: ToolHandlerWrapper = createHeartbeatWrapper();

function touchActiveSession(
  hook: HookName,
  extras: Partial<HookInput> = {},
  store?: MemoryStore,
  toolArgs?: unknown,
  options: HeartbeatOptions = {},
): void {
  const client = detectMcpClientIdentity(process.env, toolArgs);
  const cwd = process.cwd();
  const repoRoot = detectRepoRoot(cwd);
  const now = options.now?.() ?? Date.now();
  try {
    upsertActiveSession({ session_id: client.sessionId, ide: client.ide, cwd, ...extras }, hook);
  } catch {
    // Heartbeat is best-effort; never fail a tool call because the JSON sidecar cannot be written.
  }

  if (!store) return;
  try {
    store.startSession({
      id: client.sessionId,
      ide: client.ide,
      cwd,
      metadata: {
        inferred_agent: client.inferred_agent,
        confidence: client.confidence,
        source: client.source,
      },
    });
    if (shouldReconcile(repoRoot, now, options)) {
      reconcileOmxActiveSessions(store, { repoRoot });
    }
  } catch {
    // Reconciliation is best-effort; memory tools must keep serving if sidecars are unreadable.
  }
}

function heartbeatOptionsFromSettings(settings?: Settings): HeartbeatOptions {
  const minIntervalMs = settings?.runtime.activeSessionReconcileMinIntervalMs;
  return minIntervalMs === undefined ? {} : { activeSessionReconcileMinIntervalMs: minIntervalMs };
}

function shouldReconcile(repoRoot: string, now: number, options: HeartbeatOptions): boolean {
  const minIntervalMs =
    options.activeSessionReconcileMinIntervalMs ?? DEFAULT_RECONCILE_MIN_INTERVAL_MS;
  if (options.forceReconcile) {
    lastReconcileAtByRepoRoot.set(repoRoot, now);
    return true;
  }
  if (minIntervalMs <= 0) return true;
  const last = lastReconcileAtByRepoRoot.get(repoRoot);
  if (last !== undefined && now - last < minIntervalMs) return false;
  lastReconcileAtByRepoRoot.set(repoRoot, now);
  return true;
}

function detectRepoRoot(cwd: string): string {
  try {
    return detectRepoBranch(cwd)?.repo_root ?? cwd;
  } catch {
    return cwd;
  }
}

function identity(
  sessionId: string,
  agentOrIde: string,
  confidence: number,
  source: string,
): McpClientIdentity {
  const ide = ideFromAgent(agentOrIde) ?? inferIdeFromSessionId(sessionId) ?? 'unknown';
  const inferredAgent = agentFromIde(ide) ?? agentFromIde(agentOrIde) ?? 'unbound';
  return {
    sessionId,
    ide: inferredAgent === 'unbound' ? 'unknown' : ide,
    inferred_agent: inferredAgent,
    confidence: inferredAgent === 'unbound' ? 0 : confidence,
    source: inferredAgent === 'unbound' ? 'unbound' : source,
  };
}

function identityFromSessionId(sessionId: string, source: string): McpClientIdentity {
  const inferred = inferIdeFromSessionId(sessionId);
  return identity(sessionId, inferred ?? '', inferred ? 0.85 : 0, inferred ? source : 'unbound');
}

function ideFromAgent(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized || ['agent', 'unknown', 'unknown-session', 'unbound'].includes(normalized)) {
    return undefined;
  }
  if (normalized === 'claude' || normalized === 'claudecode' || normalized === 'claude-code') {
    return 'claude-code';
  }
  return normalized;
}

function agentFromIde(value: string): string | undefined {
  const ide = ideFromAgent(value);
  if (!ide) return undefined;
  return ide === 'claude-code' ? 'claude' : ide;
}

function agentFromBranch(branch: string): string | undefined {
  const parts = branch.split('/').filter(Boolean);
  if (parts[0] !== 'agent') return undefined;
  return agentFromIde(parts[1] ?? '');
}

function agentFromWorktreePath(path: string): string | undefined {
  const match = path.match(/(?:^|[/\\])[^/\\]*__([a-z][a-z0-9-]*)__/i);
  return match?.[1] ? agentFromIde(match[1]) : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
