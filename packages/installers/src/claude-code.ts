import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson, shellQuote, writeJson } from './fs-utils.js';
import type { InstallContext, Installer } from './types.js';

interface ClaudeSettings {
  hooks?: Record<
    string,
    Array<{
      matcher?: string;
      hooks: Array<{ type: string; command: string; [key: string]: unknown }>;
    }>
  >;
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
}

const HOOK_NAMES: Array<[string, string]> = [
  ['SessionStart', 'session-start'],
  ['UserPromptSubmit', 'user-prompt-submit'],
  ['PreToolUse', 'pre-tool-use'],
  ['PostToolUse', 'post-tool-use'],
  ['Stop', 'stop'],
  ['SessionEnd', 'session-end'],
];

// Scope tool-use hooks to the write-family tools that actually drive the
// auto-claim path. Bash/apply_patch are included because the auto-claim layer
// parses shell redirects/sed and patch headers into file writes.
const FILE_WRITE_TOOL_MATCHER =
  'Edit|Write|MultiEdit|NotebookEdit|Bash|apply_patch|ApplyPatch|Patch';

function matcherForHook(hookId: string): string | undefined {
  if (hookId === 'pre-tool-use' || hookId === 'post-tool-use') return FILE_WRITE_TOOL_MATCHER;
  return undefined;
}

function settingsFile(): string {
  return join(homedir(), '.claude', 'settings.json');
}

function isColonyHookCommand(command: string, hookId: string): boolean {
  const normalized = command.replace(/["']/g, ' ').replace(/\s+/g, ' ').trim();
  return /\bcolony(?:\.js)?\b/.test(normalized) && normalized.includes(` hook run ${hookId}`);
}

function installColonyHook(
  existing: NonNullable<ClaudeSettings['hooks']>[string] | undefined,
  command: string,
  hookId: string,
): NonNullable<ClaudeSettings['hooks']>[string] {
  const filtered = removeColonyHook(existing, hookId);
  const matcher = matcherForHook(hookId);
  return [
    ...filtered,
    {
      ...(matcher !== undefined ? { matcher } : {}),
      hooks: [
        {
          type: 'command',
          command,
        },
      ],
    },
  ];
}

function removeColonyHook(
  existing: NonNullable<ClaudeSettings['hooks']>[string] | undefined,
  hookId: string,
): NonNullable<ClaudeSettings['hooks']>[string] {
  return (existing ?? [])
    .map((entry) => ({
      ...entry,
      hooks: entry.hooks.filter((hook) => !isColonyHookCommand(hook.command, hookId)),
    }))
    .filter((entry) => entry.hooks.length > 0);
}

export const claudeCode: Installer = {
  id: 'claude-code',
  label: 'Claude Code',
  async detect(_ctx: InstallContext): Promise<boolean> {
    return existsSync(join(homedir(), '.claude'));
  },
  async install(ctx: InstallContext): Promise<string[]> {
    const path = settingsFile();
    const current = readJson<ClaudeSettings>(path, {});
    const hooks: ClaudeSettings['hooks'] = { ...(current.hooks ?? {}) };
    // Hook commands are shell strings, so nodeBin + cliPath must be quoted —
    // Windows npm installs land under paths like C:\Users\...\AppData that
    // may contain spaces. Both cmd.exe and sh treat "..." as one argv token.
    const nodeBin = shellQuote(ctx.nodeBin);
    const cliPath = shellQuote(ctx.cliPath);
    for (const [claudeName, hookId] of HOOK_NAMES) {
      const command = `${nodeBin} ${cliPath} hook run ${hookId} --ide claude-code`;
      hooks[claudeName] = installColonyHook(hooks[claudeName], command, hookId);
    }
    const mcpServers: NonNullable<ClaudeSettings['mcpServers']> = { ...(current.mcpServers ?? {}) };
    delete mcpServers.cavemem;
    mcpServers.colony = {
      // Spawn node explicitly — if command is the .js file, Claude Code's
      // MCP launcher can't exec it on Windows (EFTYPE).
      command: ctx.nodeBin,
      args: [ctx.cliPath, 'mcp'],
    };
    const next: ClaudeSettings = { ...current, hooks, mcpServers };
    writeJson(path, next);
    return [`wrote ${path}`];
  },
  async uninstall(_ctx: InstallContext): Promise<string[]> {
    const path = settingsFile();
    const current = readJson<ClaudeSettings>(path, {});
    if (current.hooks) {
      for (const [claudeName, hookId] of HOOK_NAMES) {
        const remaining = removeColonyHook(current.hooks[claudeName], hookId);
        if (remaining.length > 0) current.hooks[claudeName] = remaining;
        else delete current.hooks[claudeName];
      }
    }
    if (current.mcpServers) {
      delete current.mcpServers.colony;
      delete current.mcpServers.cavemem;
    }
    writeJson(path, current);
    return [`updated ${path}`];
  },
};
