import { mkdirSync } from 'node:fs';
import { loadSettingsForCwd, resolveDataDir } from '@colony/config';
import { inferIdeFromSessionId } from '@colony/core';
import { type HookName, type HookResult, runHook } from '@colony/hooks';
import type { Command } from 'commander';

const VALID: HookName[] = [
  'session-start',
  'user-prompt-submit',
  'pre-tool-use',
  'post-tool-use',
  'stop',
  'session-end',
];

// Claude Code event names — used in hookSpecificOutput.hookEventName when we
// emit additionalContext back to the agent.
const CLAUDE_EVENT_NAME: Record<HookName, string> = {
  'session-start': 'SessionStart',
  'user-prompt-submit': 'UserPromptSubmit',
  'pre-tool-use': 'PreToolUse',
  'post-tool-use': 'PostToolUse',
  stop: 'Stop',
  'session-end': 'SessionEnd',
};

export function registerHookCommand(program: Command): void {
  const hook = program.command('hook').description('Internal: hook handler entrypoints');
  hook
    .command('run <name>')
    .description('Run a hook by name (reads JSON from stdin)')
    .option('--ide <name>', 'IDE that invoked the hook (Claude Code does not send this)')
    .action(async (name: string, opts: { ide?: string }) => {
      if (!VALID.includes(name as HookName)) {
        // Stay non-blocking: the IDE's hook config could be stale.
        process.stderr.write(`${JSON.stringify({ ok: false, error: `unknown hook ${name}` })}\n`);
        process.exitCode = 1;
        return;
      }
      const hookName = name as HookName;
      const raw = await readStdin();
      const parsed = raw.trim() ? safeJson(raw) : {};
      ensureWritableHookHome(parsed);
      const sessionId = readString(parsed.session_id) ?? 'unknown';
      const ide = opts.ide ?? readString(parsed.ide) ?? inferIdeFromSessionId(sessionId);
      const input = {
        ...parsed,
        session_id: sessionId,
        cwd: readString(parsed.cwd) ?? process.cwd(),
        ...(ide ? { ide } : {}),
      } as Parameters<typeof runHook>[1];

      const result = await runHook(hookName, input);

      // Telemetry always goes to stderr — stdout is reserved for the IDE's
      // hook protocol and any text we put there is interpreted (e.g. injected
      // as additionalContext).
      process.stderr.write(`${JSON.stringify({ hook: hookName, ...result })}\n`);

      if (!result.ok) {
        // Non-blocking error: stderr already carries the structured payload;
        // exit 1 surfaces it in the IDE's hook log without blocking the turn.
        process.exitCode = 1;
        return;
      }

      writeIdeOutput(hookName, result);
    });
}

export function ensureWritableHookHome(input: Record<string, unknown>): string | null {
  if (process.env.COLONY_HOME || process.env.CAVEMEM_HOME) return null;
  const cwd = readString(input.cwd) ?? process.cwd();
  // Resolve through the same settings cascade the rest of the CLI uses so hook
  // writes land in the user's canonical Colony home (default ~/.colony) and stay
  // visible to health, MCP, and the worker. A repo can opt back into per-repo
  // isolation by checking in `.colony/settings.json` with a custom dataDir.
  const colonyHome = resolveDataDir(loadSettingsForCwd(cwd).dataDir);
  try {
    mkdirSync(colonyHome, { recursive: true });
    process.env.COLONY_HOME = colonyHome;
    return colonyHome;
  } catch {
    return null;
  }
}

function writeIdeOutput(hook: HookName, result: HookResult): void {
  const ctx = result.context?.trim();
  const decisionReason = result.permissionDecisionReason?.trim() || ctx;
  if (!ctx && !decisionReason) return;

  if (hook === 'session-start' || hook === 'user-prompt-submit') {
    if (!ctx) return;
    const payload = {
      hookSpecificOutput: {
        hookEventName: CLAUDE_EVENT_NAME[hook],
        additionalContext: ctx,
      },
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  // PreToolUse: surface the auto-claim warning to the agent via
  // permissionDecisionReason. The repo-configured bridge policy decides
  // whether this stays advisory or denies a strong active claim conflict.
  if (hook === 'pre-tool-use') {
    const payload = {
      hookSpecificOutput: {
        hookEventName: CLAUDE_EVENT_NAME[hook],
        permissionDecision: result.permissionDecision ?? 'allow',
        permissionDecisionReason: decisionReason,
      },
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
  });
}
