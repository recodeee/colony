import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './fs-utils.js';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type McpServersConfig = Record<string, McpServerConfig>;

type SourceKind = 'json' | 'toml';

interface McpSource {
  path: string;
  kind: SourceKind;
}

const SYSTEM_MCP_SOURCES = (home: string): McpSource[] => [
  { path: join(home, '.codex', 'config.toml'), kind: 'toml' },
  { path: join(home, '.codex', 'config.json'), kind: 'json' },
  { path: join(home, '.claude', 'settings.json'), kind: 'json' },
  { path: join(home, '.cursor', 'mcp.json'), kind: 'json' },
  { path: join(home, '.gemini', 'settings.json'), kind: 'json' },
  { path: join(home, '.opencode', 'config.json'), kind: 'json' },
];

export function installDetectedOmxLayer(
  mcpServers: McpServersConfig,
  homeDir = homedir(),
): string[] {
  const installed: string[] = [];
  for (const [name, server] of Object.entries(detectSystemOmxMcpServers(homeDir))) {
    if (mcpServers[name]) continue;
    mcpServers[name] = cloneMcpServer(server);
    installed.push(name);
  }
  return installed.sort((a, b) => a.localeCompare(b));
}

export function detectedOmxLayerMessages(installedServers: string[]): string[] {
  if (installedServers.length === 0) return [];
  return [`installed detected OMX MCP layer: ${installedServers.join(', ')}`];
}

export function detectSystemOmxMcpServers(homeDir = homedir()): McpServersConfig {
  const detected: McpServersConfig = {};
  for (const source of SYSTEM_MCP_SOURCES(homeDir)) {
    const servers =
      source.kind === 'toml' ? readTomlMcpServers(source.path) : readJsonMcpServers(source.path);
    for (const [name, server] of Object.entries(servers)) {
      if (detected[name] || !looksLikeOmxMcpServer(name, server)) continue;
      detected[name] = cloneMcpServer(server);
    }
  }
  return detected;
}

function readJsonMcpServers(path: string): McpServersConfig {
  const parsed = readJson<Record<string, unknown>>(path, {});
  const rawServers = parsed.mcpServers ?? parsed.mcp_servers;
  if (!isRecord(rawServers)) return {};
  return normalizeMcpServers(rawServers);
}

function readTomlMcpServers(path: string): McpServersConfig {
  if (!existsSync(path)) return {};
  try {
    return normalizeMcpServers(parseTomlMcpServers(readFileSync(path, 'utf8')));
  } catch {
    return {};
  }
}

function parseTomlMcpServers(raw: string): Record<string, unknown> {
  const servers: Record<string, Record<string, unknown>> = {};
  let currentServer: string | null = null;
  let currentPath: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const table = line.match(/^\s*\[(?:mcp_servers|mcpServers)\.([^\].]+)(?:\.([^\]]+))?\]\s*$/);
    if (table) {
      currentServer = table[1] ?? null;
      currentPath = table[2]?.split('.') ?? [];
      if (currentServer) servers[currentServer] = servers[currentServer] ?? {};
      continue;
    }

    if (!currentServer) continue;
    const assignment = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/);
    if (!assignment) continue;
    const key = assignment[1];
    const value = parseTomlScalar(assignment[2] ?? '');
    if (!key || value === undefined) continue;
    setNestedValue(servers[currentServer] ?? {}, currentPath, key, value);
  }

  return servers;
}

function parseTomlScalar(raw: string): string | string[] | undefined {
  const value = raw.replace(/\s+#.*$/, '').trim();
  const stringMatch = value.match(/^["'](.*)["']$/);
  if (stringMatch) return stringMatch[1] ?? '';
  if (value.startsWith('[') && value.endsWith(']')) {
    return [...value.matchAll(/["']([^"']*)["']/g)].map((match) => match[1] ?? '');
  }
  if (/^[A-Za-z0-9_./:@\\-]+$/.test(value)) return value;
  return undefined;
}

function setNestedValue(
  server: Record<string, unknown>,
  path: string[],
  key: string,
  value: string | string[],
): void {
  let target = server;
  for (const part of path) {
    const existing = target[part];
    if (!isRecord(existing)) target[part] = {};
    target = target[part] as Record<string, unknown>;
  }
  target[key] = value;
}

function normalizeMcpServers(rawServers: Record<string, unknown>): McpServersConfig {
  const servers: McpServersConfig = {};
  for (const [name, rawServer] of Object.entries(rawServers)) {
    if (!isRecord(rawServer) || typeof rawServer.command !== 'string') continue;
    const server: McpServerConfig = { command: rawServer.command };
    if (Array.isArray(rawServer.args) && rawServer.args.every((arg) => typeof arg === 'string')) {
      server.args = [...rawServer.args];
    }
    if (isRecord(rawServer.env)) {
      const env = Object.fromEntries(
        Object.entries(rawServer.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
      if (Object.keys(env).length > 0) server.env = env;
    }
    servers[name] = server;
  }
  return servers;
}

function looksLikeOmxMcpServer(name: string, server: McpServerConfig): boolean {
  if (/^omx(?:[_-]|$)/i.test(name)) return true;
  const haystack = [server.command, ...(server.args ?? [])].join(' ').toLowerCase();
  const mentionsOmx = /\bomx\b/.test(haystack) || haystack.includes('oh-my-codex');
  const mentionsMcp =
    /\bmcp\b/.test(haystack) || haystack.includes('/mcp/') || haystack.includes('\\mcp\\');
  return mentionsOmx && mentionsMcp;
}

function cloneMcpServer(server: McpServerConfig): McpServerConfig {
  return {
    command: server.command,
    ...(server.args ? { args: [...server.args] } : {}),
    ...(server.env ? { env: { ...server.env } } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
