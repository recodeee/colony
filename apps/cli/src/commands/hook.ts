import { type HookName, type HookResult, runHook } from '@colony/hooks';
import type { Command } from 'commander';

const VALID: HookName[] = [
  'session-start',
  'user-prompt-submit',
  'post-tool-use',
  'stop',
  'session-end',
];

// Claude Code event names — used in hookSpecificOutput.hookEventName when we
// emit additionalContext back to the agent.
const CLAUDE_EVENT_NAME: Record<HookName, string> = {
  'session-start': 'SessionStart',
  'user-prompt-submit': 'UserPromptSubmit',
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

function writeIdeOutput(hook: HookName, result: HookResult): void {
  // Only SessionStart and UserPromptSubmit can usefully feed text back into
  // the agent. For other hooks we deliberately stay silent on stdout.
  if (hook !== 'session-start' && hook !== 'user-prompt-submit') return;
  const ctx = result.context?.trim();
  if (!ctx) return;
  const payload = {
    hookSpecificOutput: {
      hookEventName: CLAUDE_EVENT_NAME[hook],
      additionalContext: ctx,
    },
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
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

function inferIdeFromSessionId(sessionId: string): string | undefined {
  const prefix = sessionId.split('@')[0]?.toLowerCase();
  if (prefix === 'codex') return 'codex';
  if (prefix === 'claude' || prefix === 'claude-code') return 'claude-code';
  return undefined;
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
