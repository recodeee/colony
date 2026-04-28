import { loadSettings } from '@colony/config';
import type { MemoryStore } from '@colony/core';
import type { Command } from 'commander';
import kleur from 'kleur';
import { withStore } from '../util/store.js';

interface BridgeStatusCommandOptions {
  repoRoot?: string;
  sessionId?: string;
  agent?: string;
  branch?: string;
  json?: boolean;
}

type BridgeStatusBuilder = (
  store: MemoryStore,
  options: {
    session_id: string;
    agent: string;
    repo_root: string;
    branch?: string;
  },
) => Promise<{
  branch: string | null;
  task: string | null;
  blocker: string | null;
  next_action: string;
  attention: {
    unread_count: number;
    blocking_count: number;
    pending_handoff_count: number;
    pending_wake_count: number;
    stalled_lane_count: number;
  };
  ready_work_count: number;
  claimed_file_count: number;
}>;

interface BridgeCommandDeps {
  buildBridgeStatusPayload?: BridgeStatusBuilder;
}

function sessionFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    env.CODEX_SESSION_ID?.trim() ||
    env.CLAUDECODE_SESSION_ID?.trim() ||
    env.CLAUDE_SESSION_ID?.trim() ||
    undefined
  );
}

function agentFromSession(sessionId: string): string | undefined {
  const ide = inferIdeFromSessionId(sessionId);
  if (ide === 'claude-code') return 'claude';
  return ide;
}

function inferIdeFromSessionId(sessionId: string): string | undefined {
  const parts = sessionId.split(/[@\-:/_]/).map((part) => part.toLowerCase());
  const first = parts[0];
  if (!first) return undefined;
  const candidate = first === 'agent' && parts[1] ? parts[1] : first;
  switch (candidate) {
    case 'claude':
    case 'claudecode':
      return 'claude-code';
    case 'codex':
      return 'codex';
    case 'gemini':
      return 'gemini';
    case 'cursor':
      return 'cursor';
    case 'windsurf':
      return 'windsurf';
    case 'aider':
      return 'aider';
    default:
      return undefined;
  }
}

export function registerBridgeCommand(program: Command, deps: BridgeCommandDeps = {}): void {
  const bridge = program
    .command('bridge')
    .description('OMX/HUD bridge helpers for compact Colony status');

  bridge
    .command('status')
    .description('Show compact Colony coordination status for HUD consumers')
    .option('--repo-root <path>', 'repo root to scan (defaults to cwd)')
    .option('--session-id <id>', 'your session_id (defaults to CODEX_SESSION_ID)')
    .option('--agent <name>', 'agent name (e.g. codex, claude); inferred from session when omitted')
    .option('--branch <branch>', 'current branch hint used to pick the active lane')
    .option('--json', 'emit the bridge payload as JSON')
    .action(async (opts: BridgeStatusCommandOptions) => {
      const sessionId = opts.sessionId?.trim() || sessionFromEnv();
      if (!sessionId) {
        process.stderr.write(
          `${kleur.red('missing session')} - pass --session-id or set CODEX_SESSION_ID/CLAUDECODE_SESSION_ID\n`,
        );
        process.exitCode = 1;
        return;
      }

      const agent = opts.agent?.trim() || agentFromSession(sessionId);
      if (!agent) {
        process.stderr.write(
          `${kleur.red('missing agent')} - pass --agent or use a session id prefixed with codex@/claude@\n`,
        );
        process.exitCode = 1;
        return;
      }

      const settings = loadSettings();
      const repoRoot = opts.repoRoot?.trim() || process.cwd();
      await withStore(settings, async (store) => {
        const buildBridgeStatusPayload =
          deps.buildBridgeStatusPayload ??
          (await import('@colony/mcp-server')).buildBridgeStatusPayload;
        const payload = await buildBridgeStatusPayload(store, {
          session_id: sessionId,
          agent,
          repo_root: repoRoot,
          ...(opts.branch?.trim() ? { branch: opts.branch.trim() } : {}),
        });

        if (opts.json) {
          process.stdout.write(`${JSON.stringify(payload)}\n`);
          return;
        }

        process.stdout.write(`${kleur.bold('Colony bridge status')}\n`);
        process.stdout.write(`  branch: ${payload.branch ?? '-'}\n`);
        process.stdout.write(`  task: ${payload.task ?? '-'}\n`);
        process.stdout.write(`  blocker: ${payload.blocker ?? 'none'}\n`);
        process.stdout.write(`  next: ${payload.next_action}\n`);
        process.stdout.write(
          `  attention: unread=${payload.attention.unread_count} blocking=${payload.attention.blocking_count} handoffs=${payload.attention.pending_handoff_count} wakes=${payload.attention.pending_wake_count} stalled=${payload.attention.stalled_lane_count}\n`,
        );
        process.stdout.write(`  ready work: ${payload.ready_work_count}\n`);
        process.stdout.write(`  claimed files: ${payload.claimed_file_count}\n`);
      });
    });
}
