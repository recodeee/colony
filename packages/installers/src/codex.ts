import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJson } from './fs-utils.js';
import type { InstallContext, Installer } from './types.js';

interface CodexConfig {
  mcpServers?: Record<string, { command: string; args?: string[] }>;
}

function configFile(): string {
  return join(homedir(), '.codex', 'config.json');
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
    return [`wrote ${path}`];
  },
  async uninstall(_ctx): Promise<string[]> {
    const path = configFile();
    const current = readJson<CodexConfig>(path, {});
    if (current.mcpServers) {
      delete current.mcpServers.colony;
      delete current.mcpServers.cavemem;
    }
    writeJson(path, current);
    return [`updated ${path}`];
  },
};
