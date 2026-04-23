import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson, shellQuote, writeJson } from './fs-utils.js';
import type { InstallContext, Installer } from './types.js';

interface ClaudeSettings {
  hooks?: Record<
    string,
    Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>
  >;
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
}

const HOOK_NAMES: Array<[string, string]> = [
  ['SessionStart', 'session-start'],
  ['UserPromptSubmit', 'user-prompt-submit'],
  ['PostToolUse', 'post-tool-use'],
  ['Stop', 'stop'],
  ['SessionEnd', 'session-end'],
];

function settingsFile(): string {
  return join(homedir(), '.claude', 'settings.json');
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
      hooks[claudeName] = [
        {
          hooks: [
            {
              type: 'command',
              command: `${nodeBin} ${cliPath} hook run ${hookId} --ide claude-code`,
            },
          ],
        },
      ];
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
      for (const [claudeName] of HOOK_NAMES) delete current.hooks[claudeName];
    }
    if (current.mcpServers) {
      delete current.mcpServers.colony;
      delete current.mcpServers.cavemem;
    }
    writeJson(path, current);
    return [`updated ${path}`];
  },
};
