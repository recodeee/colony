import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson, shellQuote, writeJson } from './fs-utils.js';
import {
  type McpServerConfig,
  type McpServersConfig,
  detectSystemOmxMcpServers,
  detectedOmxLayerMessages,
  installDetectedOmxLayer,
} from './omx-layer.js';
import type {
  InstallContext,
  InstallValidationIssue,
  InstallValidationResult,
  Installer,
} from './types.js';

interface CodexConfig {
  mcpServers?: McpServersConfig;
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

const REQUIRED_MCP_SERVER = 'colony';

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

function commandForHook(ctx: InstallContext, hookId: string): string {
  return `${shellQuote(ctx.nodeBin)} ${shellQuote(ctx.cliPath)} hook run ${hookId} --ide codex`;
}

function isColonyHookCommand(command: string, hookId: string): boolean {
  const normalized = command.replace(/["']/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized.includes(` hook run ${hookId}`) && normalized.includes('--ide codex');
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
    const installedOmxServers = installDetectedOmxLayer(mcpServers);
    const next: CodexConfig = { ...current, mcpServers };
    writeJson(path, next);

    const hooksPath = hooksFile();
    const hooksCurrent = readJson<CodexHooksConfig>(hooksPath, {});
    const hooks: CodexHooksConfig['hooks'] = { ...(hooksCurrent.hooks ?? {}) };
    for (const [codexName, hookId] of HOOK_NAMES) {
      const command = commandForHook(ctx, hookId);
      hooks[codexName] = installColonyHook(hooks[codexName], command, hookId);
    }
    writeJson(hooksPath, { ...hooksCurrent, hooks });
    const validation = validateCodexInstall(ctx);
    if (!validation.ok) throw new Error(formatValidationFailure(validation));
    return [
      `wrote ${path}`,
      `wrote ${hooksPath}`,
      ...detectedOmxLayerMessages(installedOmxServers),
      ...validation.messages,
    ];
  },
  async verify(ctx: InstallContext): Promise<InstallValidationResult> {
    return validateCodexInstall(ctx);
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

export function validateCodexInstall(ctx: InstallContext): InstallValidationResult {
  const issues: InstallValidationIssue[] = [];
  const path = configFile();
  const config = readJson<CodexConfig>(path, {});
  const colonyMcp = config.mcpServers?.[REQUIRED_MCP_SERVER];
  if (colonyMcp?.command !== ctx.nodeBin || !sameArgs(colonyMcp.args, [ctx.cliPath, 'mcp'])) {
    issues.push(
      validationIssue({
        file: path,
        missingMcpServers: [REQUIRED_MCP_SERVER],
      }),
    );
  }
  const missingOmxServers = missingDetectedOmxServers(config.mcpServers ?? {});
  if (missingOmxServers.length > 0) {
    issues.push(
      validationIssue({
        file: path,
        missingMcpServers: missingOmxServers,
      }),
    );
  }

  const hooksPath = hooksFile();
  const hooksCurrent = readJson<CodexHooksConfig>(hooksPath, {});
  const missingHooks: string[] = [];
  const staleHooks: string[] = [];
  for (const [codexName, hookId] of HOOK_NAMES) {
    const status = codexHookStatus(hooksCurrent.hooks?.[codexName], ctx, hookId);
    if (status === 'missing') missingHooks.push(codexName);
    else if (status === 'stale') staleHooks.push(codexName);
  }
  if (missingHooks.length > 0 || staleHooks.length > 0) {
    issues.push(validationIssue({ file: hooksPath, missingHooks, staleHooks }));
  }

  return {
    ok: issues.length === 0,
    issues,
    messages:
      issues.length === 0
        ? [
            `verified ${path}`,
            `verified ${hooksPath}: ${HOOK_NAMES.map(([name]) => name).join(', ')}`,
          ]
        : [],
  };
}

type CodexHookStatus = 'ok' | 'missing' | 'stale';

function codexHookStatus(
  entries: NonNullable<CodexHooksConfig['hooks']>[string] | undefined,
  ctx: InstallContext,
  hookId: string,
): CodexHookStatus {
  if (!entries || entries.length === 0) return 'missing';
  const expectedCommand = commandForHook(ctx, hookId);
  const expectedMatcher = matcherForHook(hookId);
  let sawColonyHook = false;

  for (const entry of entries) {
    for (const hook of entry.hooks) {
      const commandMatches = hook.command === expectedCommand;
      if (!isColonyHookCommand(hook.command, hookId) && !commandMatches) continue;
      sawColonyHook = true;
      if (commandMatches && hook.type === 'command' && entry.matcher === expectedMatcher) {
        return 'ok';
      }
    }
  }

  return sawColonyHook ? 'stale' : 'missing';
}

function sameArgs(actual: string[] | undefined, expected: string[]): boolean {
  const actualArgs = actual ?? [];
  if (actualArgs.length !== expected.length) return false;
  return expected.every((value, index) => actualArgs[index] === value);
}

function missingDetectedOmxServers(current: McpServersConfig): string[] {
  const missing: string[] = [];
  for (const [name, expected] of Object.entries(detectSystemOmxMcpServers())) {
    const actual = current[name];
    if (!actual || !sameMcpServer(actual, expected)) missing.push(name);
  }
  return missing.sort((a, b) => a.localeCompare(b));
}

function sameMcpServer(actual: McpServerConfig, expected: McpServerConfig): boolean {
  if (actual.command !== expected.command || !sameArgs(actual.args, expected.args ?? [])) {
    return false;
  }
  return sameEnv(actual.env, expected.env);
}

function sameEnv(
  actual: Record<string, string> | undefined,
  expected: Record<string, string> | undefined,
): boolean {
  const actualEntries = Object.entries(actual ?? {}).sort();
  const expectedEntries = Object.entries(expected ?? {}).sort();
  return (
    actualEntries.length === expectedEntries.length &&
    expectedEntries.every(
      ([key, value], index) =>
        actualEntries[index]?.[0] === key && actualEntries[index]?.[1] === value,
    )
  );
}

function validationIssue(args: {
  file: string;
  missingHooks?: string[];
  staleHooks?: string[];
  missingMcpServers?: string[];
}): InstallValidationIssue {
  const parts: string[] = [];
  if (args.missingHooks && args.missingHooks.length > 0) {
    parts.push(`missing hooks: ${args.missingHooks.join(', ')}`);
  }
  if (args.staleHooks && args.staleHooks.length > 0) {
    parts.push(`stale hooks: ${args.staleHooks.join(', ')}`);
  }
  if (args.missingMcpServers && args.missingMcpServers.length > 0) {
    parts.push(`missing MCP servers: ${args.missingMcpServers.join(', ')}`);
  }
  return {
    file: args.file,
    message: parts.join('; '),
    ...(args.missingHooks && args.missingHooks.length > 0
      ? { missingHooks: args.missingHooks }
      : {}),
    ...(args.staleHooks && args.staleHooks.length > 0 ? { staleHooks: args.staleHooks } : {}),
    ...(args.missingMcpServers && args.missingMcpServers.length > 0
      ? { missingMcpServers: args.missingMcpServers }
      : {}),
  };
}

export function formatValidationFailure(result: InstallValidationResult): string {
  return [
    'Codex Colony install validation failed.',
    ...result.issues.map((issue) => `${issue.file}: ${issue.message}`),
  ].join('\n');
}
