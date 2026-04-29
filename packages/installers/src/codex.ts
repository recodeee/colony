import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson, shellQuote, writeJson } from './fs-utils.js';
import type { InstallContext, Installer } from './types.js';

interface CodexConfig {
  mcpServers?: Record<string, { command: string; args?: string[] }>;
}

interface CodexHooksConfig {
  hooks?: Record<
    string,
    Array<{
      matcher?: string;
      hooks: Array<{ type: string; command: string; [key: string]: unknown }>;
    }>
  >;
}

const HOOK_NAMES: Array<[string, string]> = [
  ['SessionStart', 'session-start'],
  ['UserPromptSubmit', 'user-prompt-submit'],
  ['PreToolUse', 'pre-tool-use'],
  ['PostToolUse', 'post-tool-use'],
  ['Stop', 'stop'],
];

// Codex hooks support the same matcher grammar as Claude Code for tool-use
// events. Keep this aligned with the Claude installer so claim-before-edit
// telemetry covers the same write-family tools.
const FILE_WRITE_TOOL_MATCHER =
  'Edit|Write|MultiEdit|NotebookEdit|Bash|apply_patch|ApplyPatch|Patch';

function configFile(): string {
  return join(homedir(), '.codex', 'config.json');
}

function hooksFile(): string {
  return join(homedir(), '.codex', 'hooks.json');
}

function matcherForHook(hookId: string): string | undefined {
  if (hookId === 'pre-tool-use' || hookId === 'post-tool-use') return FILE_WRITE_TOOL_MATCHER;
  if (hookId === 'session-start') return 'startup|resume';
  return undefined;
}

function isColonyHookCommand(command: string, hookId: string): boolean {
  const normalized = command.replace(/["']/g, ' ').replace(/\s+/g, ' ').trim();
  return /\bcolony(?:\.js)?\b/.test(normalized) && normalized.includes(` hook run ${hookId}`);
}

function installColonyHook(
  existing: NonNullable<CodexHooksConfig['hooks']>[string] | undefined,
  command: string,
  hookId: string,
): NonNullable<CodexHooksConfig['hooks']>[string] {
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
  existing: NonNullable<CodexHooksConfig['hooks']>[string] | undefined,
  hookId: string,
): NonNullable<CodexHooksConfig['hooks']>[string] {
  return (existing ?? [])
    .map((entry) => ({
      ...entry,
      hooks: entry.hooks.filter((hook) => !isColonyHookCommand(hook.command, hookId)),
    }))
    .filter((entry) => entry.hooks.length > 0);
}

export const codex: Installer = {
  id: 'codex',
  label: 'Codex CLI',
  async detect(_ctx): Promise<boolean> {
    return existsSync(join(homedir(), '.codex'));
  },
  async install(ctx: InstallContext): Promise<string[]> {
    const path = configFile();
    const current = readJson<CodexConfig>(path, {});
    const mcpServers = { ...(current.mcpServers ?? {}) };
    delete mcpServers.cavemem;
    mcpServers.colony = { command: ctx.nodeBin, args: [ctx.cliPath, 'mcp'] };
    const next: CodexConfig = { ...current, mcpServers };
    writeJson(path, next);

    const hooksPath = hooksFile();
    const hooksCurrent = readJson<CodexHooksConfig>(hooksPath, {});
    const hooks: CodexHooksConfig['hooks'] = { ...(hooksCurrent.hooks ?? {}) };
    const nodeBin = shellQuote(ctx.nodeBin);
    const cliPath = shellQuote(ctx.cliPath);
    for (const [codexName, hookId] of HOOK_NAMES) {
      const command = `${nodeBin} ${cliPath} hook run ${hookId} --ide codex`;
      hooks[codexName] = installColonyHook(hooks[codexName], command, hookId);
    }
    writeJson(hooksPath, { ...hooksCurrent, hooks });
    return [`wrote ${path}`, `wrote ${hooksPath}`];
  },
  async uninstall(_ctx): Promise<string[]> {
    const path = configFile();
    const current = readJson<CodexConfig>(path, {});
    if (current.mcpServers) {
      delete current.mcpServers.colony;
      delete current.mcpServers.cavemem;
    }
    writeJson(path, current);

    const hooksPath = hooksFile();
    const hooksCurrent = readJson<CodexHooksConfig>(hooksPath, {});
    if (hooksCurrent.hooks) {
      for (const [codexName, hookId] of HOOK_NAMES) {
        const remaining = removeColonyHook(hooksCurrent.hooks[codexName], hookId);
        if (remaining.length > 0) hooksCurrent.hooks[codexName] = remaining;
        else delete hooksCurrent.hooks[codexName];
      }
    }
    writeJson(hooksPath, hooksCurrent);
    return [`updated ${path}`, `updated ${hooksPath}`];
  },
};
