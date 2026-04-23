import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJson } from './fs-utils.js';
import type { InstallContext, Installer } from './types.js';

interface OpenCodeConfig {
  mcpServers?: Record<string, { command: string; args?: string[] }>;
}

function configFile(): string {
  return join(homedir(), '.opencode', 'config.json');
}

export const openCode: Installer = {
  id: 'opencode',
  label: 'OpenCode',
  async detect(_ctx): Promise<boolean> {
    return existsSync(join(homedir(), '.opencode'));
  },
  async install(ctx: InstallContext): Promise<string[]> {
    const path = configFile();
    const current = readJson<OpenCodeConfig>(path, {});
    const mcpServers = { ...(current.mcpServers ?? {}) };
    delete mcpServers.cavemem;
    mcpServers.colony = { command: ctx.nodeBin, args: [ctx.cliPath, 'mcp'] };
    const next: OpenCodeConfig = { ...current, mcpServers };
    writeJson(path, next);
    return [`wrote ${path}`];
  },
  async uninstall(_ctx): Promise<string[]> {
    const path = configFile();
    const current = readJson<OpenCodeConfig>(path, {});
    if (current.mcpServers) {
      delete current.mcpServers.colony;
      delete current.mcpServers.cavemem;
    }
    writeJson(path, current);
    return [`updated ${path}`];
  },
};
