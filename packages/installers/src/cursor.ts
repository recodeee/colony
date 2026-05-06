import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJson } from './fs-utils.js';
import {
  type McpServersConfig,
  detectedOmxLayerMessages,
  installDetectedOmxLayer,
} from './omx-layer.js';
import type { InstallContext, Installer } from './types.js';

interface CursorConfig {
  mcpServers?: McpServersConfig;
}

function configFile(): string {
  return join(homedir(), '.cursor', 'mcp.json');
}

export const cursor: Installer = {
  id: 'cursor',
  label: 'Cursor',
  async detect(_ctx): Promise<boolean> {
    return existsSync(join(homedir(), '.cursor'));
  },
  async install(ctx: InstallContext): Promise<string[]> {
    const path = configFile();
    const current = readJson<CursorConfig>(path, {});
    const mcpServers = { ...(current.mcpServers ?? {}) };
    delete mcpServers.cavemem;
    mcpServers.colony = { command: ctx.nodeBin, args: [ctx.cliPath, 'mcp'] };
    const installedOmxServers = installDetectedOmxLayer(mcpServers);
    const next: CursorConfig = { ...current, mcpServers };
    writeJson(path, next);
    return [`wrote ${path}`, ...detectedOmxLayerMessages(installedOmxServers)];
  },
  async uninstall(_ctx): Promise<string[]> {
    const path = configFile();
    const current = readJson<CursorConfig>(path, {});
    if (current.mcpServers) {
      delete current.mcpServers.colony;
      delete current.mcpServers.cavemem;
    }
    writeJson(path, current);
    return [`updated ${path}`];
  },
};
