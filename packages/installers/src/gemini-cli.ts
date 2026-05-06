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

interface GeminiSettings {
  mcpServers?: McpServersConfig;
  contextFiles?: string[];
}

function settingsFile(): string {
  return join(homedir(), '.gemini', 'settings.json');
}

export const geminiCli: Installer = {
  id: 'gemini-cli',
  label: 'Gemini CLI',
  async detect(_ctx): Promise<boolean> {
    return existsSync(join(homedir(), '.gemini'));
  },
  async install(ctx: InstallContext): Promise<string[]> {
    const path = settingsFile();
    const current = readJson<GeminiSettings>(path, {});
    const mcpServers = { ...(current.mcpServers ?? {}) };
    delete mcpServers.cavemem;
    mcpServers.colony = { command: ctx.nodeBin, args: [ctx.cliPath, 'mcp'] };
    const installedOmxServers = installDetectedOmxLayer(mcpServers);
    const next: GeminiSettings = { ...current, mcpServers };
    writeJson(path, next);
    return [`wrote ${path}`, ...detectedOmxLayerMessages(installedOmxServers)];
  },
  async uninstall(_ctx): Promise<string[]> {
    const path = settingsFile();
    const current = readJson<GeminiSettings>(path, {});
    if (current.mcpServers) {
      delete current.mcpServers.colony;
      delete current.mcpServers.cavemem;
    }
    writeJson(path, current);
    return [`updated ${path}`];
  },
};
