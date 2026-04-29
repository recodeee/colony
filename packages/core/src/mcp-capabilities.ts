import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MCP_CAPABILITY_CATEGORIES = [
  'coordination',
  'memory',
  'repo/code',
  'git/github',
  'issue-tracker',
  'docs/search',
  'browser/ui',
  'ci/test',
  'filesystem',
  'unknown',
] as const;

export type McpCapabilityCategory = (typeof MCP_CAPABILITY_CATEGORIES)[number];

export interface McpServerConfig {
  command?: string;
  args?: string[];
  url?: string;
  transport?: string;
  env?: Record<string, string | undefined>;
  [key: string]: unknown;
}

export interface McpConfigSource {
  id: string;
  path?: string;
  servers: Record<string, McpServerConfig>;
}

export interface McpServerCapability {
  server: string;
  categories: McpCapabilityCategory[];
  capabilities: string[];
  sources: string[];
}

export interface McpCapabilityMap {
  generated_at: string;
  servers: Record<string, McpServerCapability>;
  summary: string[];
  unknown_servers: string[];
}

export interface DiscoverMcpCapabilitiesOptions {
  now?: number;
  homeDir?: string;
  sources?: McpConfigSource[];
}

interface KnownSource {
  id: string;
  path: string;
  kind: 'json' | 'toml';
}

const CATEGORY_ORDER = new Map<McpCapabilityCategory, number>(
  MCP_CAPABILITY_CATEGORIES.map((category, index) => [category, index]),
);

const KNOWN_SOURCE_PATHS = (home: string): KnownSource[] => [
  { id: 'codex', path: join(home, '.codex', 'config.json'), kind: 'json' },
  { id: 'codex', path: join(home, '.codex', 'config.toml'), kind: 'toml' },
  { id: 'claude-code', path: join(home, '.claude', 'settings.json'), kind: 'json' },
  { id: 'cursor', path: join(home, '.cursor', 'mcp.json'), kind: 'json' },
  { id: 'gemini-cli', path: join(home, '.gemini', 'settings.json'), kind: 'json' },
  { id: 'opencode', path: join(home, '.opencode', 'config.json'), kind: 'json' },
];

export function discoverMcpCapabilities(
  options: DiscoverMcpCapabilitiesOptions = {},
): McpCapabilityMap {
  const sources = options.sources ?? readConfiguredMcpSources(options.homeDir);
  const servers = new Map<string, McpServerCapability>();

  for (const source of sources) {
    for (const [name, config] of Object.entries(source.servers)) {
      const classification = classifyMcpServer(name, config);
      const existing = servers.get(name);
      if (existing) {
        existing.categories = orderedCategories([
          ...existing.categories,
          ...classification.categories,
        ]);
        existing.capabilities = orderedStrings([
          ...existing.capabilities,
          ...classification.capabilities,
        ]);
        existing.sources = orderedStrings([...existing.sources, source.id]);
      } else {
        servers.set(name, {
          server: name,
          categories: classification.categories,
          capabilities: classification.capabilities,
          sources: [source.id],
        });
      }
    }
  }

  const sortedServers = Object.fromEntries(
    Array.from(servers.entries()).sort(([a], [b]) => a.localeCompare(b)),
  );
  const unknownServers = Object.values(sortedServers)
    .filter((server) => server.categories.includes('unknown'))
    .map((server) => server.server);

  return {
    generated_at: new Date(options.now ?? Date.now()).toISOString(),
    servers: sortedServers,
    summary: Object.values(sortedServers).map(formatMcpCapabilitySummary),
    unknown_servers: unknownServers,
  };
}

export function classifyMcpServer(
  name: string,
  config: McpServerConfig = {},
): Omit<McpServerCapability, 'server' | 'sources'> {
  const haystack = [
    name,
    config.command,
    ...(Array.isArray(config.args) ? config.args : []),
    config.url,
    config.transport,
    ...Object.keys(config.env ?? {}),
    ...Object.values(config.env ?? {}),
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();

  const categories = new Set<McpCapabilityCategory>();
  const capabilities = new Set<string>();

  addIf(
    haystack,
    categories,
    capabilities,
    /colony|hivemind|queen|task[_-]?ready|claim/,
    ['coordination'],
    ['claims', 'plans'],
  );
  addIf(
    haystack,
    categories,
    capabilities,
    /omx|oh-my-codex|state_get|notepad/,
    ['memory'],
    ['runtime-state'],
  );
  addIf(
    haystack,
    categories,
    capabilities,
    /cavemem|memory|recall|observation|notepad/,
    ['memory'],
    ['memory'],
  );
  addIf(
    haystack,
    categories,
    capabilities,
    /github|gh\b|gitlab|bitbucket/,
    ['repo/code', 'git/github', 'issue-tracker'],
    ['repo', 'issues', 'PRs'],
  );
  addIf(
    haystack,
    categories,
    capabilities,
    /jira|linear|issue|youtrack/,
    ['issue-tracker'],
    ['issues'],
  );
  addIf(
    haystack,
    categories,
    capabilities,
    /filesystem|\bfs\b|file-system|read_file|write_file/,
    ['repo/code', 'filesystem'],
    ['repo-inspection'],
  );
  addIf(
    haystack,
    categories,
    capabilities,
    /git\b|repo|code|sourcegraph|ripgrep|\brg\b/,
    ['repo/code'],
    ['repo-inspection'],
  );
  addIf(
    haystack,
    categories,
    capabilities,
    /browser|playwright|puppeteer|chrome|\bui\b|screenshot/,
    ['browser/ui'],
    ['ui-inspection'],
  );
  addIf(
    haystack,
    categories,
    capabilities,
    /docs|search|web|fetch|brave|exa|perplexity|tavily/,
    ['docs/search'],
    ['docs-search'],
  );
  addIf(
    haystack,
    categories,
    capabilities,
    /ci|test|buildkite|circleci|jenkins|actions|workflow/,
    ['ci/test'],
    ['ci-test'],
  );

  if (categories.size === 0) {
    categories.add('unknown');
    capabilities.add('unknown');
  }

  return {
    categories: orderedCategories([...categories]),
    capabilities: orderedStrings([...capabilities]),
  };
}

export function formatMcpCapabilitySummary(server: McpServerCapability): string {
  return `${server.server}: ${server.capabilities.join(', ')}`;
}

export function readConfiguredMcpSources(homeDir = homedir()): McpConfigSource[] {
  const sources: McpConfigSource[] = [];
  for (const source of KNOWN_SOURCE_PATHS(homeDir)) {
    const servers = readMcpServersFromPath(source);
    if (servers && Object.keys(servers).length > 0) {
      sources.push({ id: source.id, path: source.path, servers });
    }
  }
  return sources;
}

function readMcpServersFromPath(source: KnownSource): Record<string, McpServerConfig> | null {
  if (!existsSync(source.path)) return null;
  try {
    const raw = readFileSync(source.path, 'utf8');
    if (source.kind === 'toml') return parseTomlMcpServers(raw);
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const servers = parsed.mcpServers ?? parsed.mcp_servers;
    return isServerRecord(servers) ? servers : null;
  } catch {
    return null;
  }
}

function parseTomlMcpServers(raw: string): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  let current: string | null = null;

  for (const line of raw.split(/\r?\n/)) {
    const table = line.match(/^\s*\[(?:mcp_servers|mcpServers)\.([A-Za-z0-9_.-]+)\]\s*$/);
    if (table) {
      current = table[1] ?? null;
      if (current) servers[current] = servers[current] ?? {};
      continue;
    }
    if (!current) continue;
    const assignment = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/);
    if (!assignment) continue;
    const key = assignment[1];
    const value = parseTomlScalar(assignment[2] ?? '');
    const server = servers[current];
    if (server && key && value !== undefined) server[key] = value;
  }

  return servers;
}

function parseTomlScalar(raw: string): string | string[] | undefined {
  const value = raw.replace(/\s+#.*$/, '').trim();
  const stringMatch = value.match(/^["'](.*)["']$/);
  if (stringMatch) return stringMatch[1] ?? '';
  if (value.startsWith('[') && value.endsWith(']')) {
    return [...value.matchAll(/["']([^"']+)["']/g)].map((match) => match[1] ?? '');
  }
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return undefined;
}

function addIf(
  haystack: string,
  categories: Set<McpCapabilityCategory>,
  capabilities: Set<string>,
  pattern: RegExp,
  nextCategories: McpCapabilityCategory[],
  nextCapabilities: string[],
): void {
  if (!pattern.test(haystack)) return;
  for (const category of nextCategories) categories.add(category);
  for (const capability of nextCapabilities) capabilities.add(capability);
}

function orderedCategories(categories: McpCapabilityCategory[]): McpCapabilityCategory[] {
  return [...new Set(categories)].sort(
    (a, b) => (CATEGORY_ORDER.get(a) ?? 999) - (CATEGORY_ORDER.get(b) ?? 999),
  );
}

function orderedStrings(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function isServerRecord(value: unknown): value is Record<string, McpServerConfig> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((server) => isRecord(server));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
