import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyMcpServer,
  discoverMcpCapabilities,
  readConfiguredMcpSources,
} from '../src/mcp-capabilities.js';

let tmpHome: string | null = null;

afterEach(() => {
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  tmpHome = null;
});

describe('MCP capability discovery', () => {
  it('classifies fake configured MCP servers without requiring installs', () => {
    const map = discoverMcpCapabilities({
      now: 1_800_000_000_000,
      sources: [
        {
          id: 'fixture',
          servers: {
            colony: { command: 'node', args: ['colony', 'mcp'] },
            omx: { command: 'omx', args: ['mcp'] },
            github: { command: 'github-mcp-server' },
            filesystem: { command: 'mcp-server-filesystem', args: ['/repo'] },
            playwright: { command: 'mcp-server-playwright' },
            buildkite: { command: 'buildkite-ci-mcp' },
            weird: { command: 'custom-daemon' },
          },
        },
      ],
    });

    expect(map.generated_at).toBe('2027-01-15T08:00:00.000Z');
    expect(map.servers.colony?.categories).toEqual(['coordination']);
    expect(map.servers.colony?.capabilities).toEqual(['claims', 'plans']);
    expect(map.servers.omx?.categories).toEqual(['memory']);
    expect(map.servers.omx?.capabilities).toEqual(['runtime-state']);
    expect(map.servers.github?.categories).toEqual([
      'repo/code',
      'git/github',
      'issue-tracker',
    ]);
    expect(map.servers.github?.capabilities).toEqual(['issues', 'PRs', 'repo']);
    expect(map.servers.filesystem?.categories).toEqual(['repo/code', 'filesystem']);
    expect(map.servers.filesystem?.capabilities).toEqual(['repo-inspection']);
    expect(map.servers.playwright?.categories).toEqual(['browser/ui']);
    expect(map.servers.buildkite?.categories).toEqual(['ci/test']);
    expect(map.servers.weird?.categories).toEqual(['unknown']);
    expect(map.unknown_servers).toEqual(['weird']);
    expect(map.summary).toContain('colony: claims, plans');
  });

  it('merges duplicate server definitions across config sources', () => {
    const map = discoverMcpCapabilities({
      sources: [
        { id: 'codex', servers: { github: { command: 'github-mcp-server' } } },
        { id: 'claude-code', servers: { github: { command: 'gh', args: ['issues'] } } },
      ],
    });

    expect(map.servers.github?.sources).toEqual(['claude-code', 'codex']);
    expect(map.servers.github?.categories).toEqual([
      'repo/code',
      'git/github',
      'issue-tracker',
    ]);
  });

  it('reads JSON and TOML MCP server configs from a fake home directory', () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'colony-mcp-home-'));
    const codexDir = join(tmpHome, '.codex');
    const claudeDir = join(tmpHome, '.claude');
    const cursorDir = join(tmpHome, '.cursor');
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      join(codexDir, 'config.toml'),
      '[mcp_servers.github]\ncommand = "github-mcp-server"\nargs = ["stdio"]\n',
      'utf8',
    );
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ mcpServers: { colony: { command: 'node', args: ['colony', 'mcp'] } } }),
      'utf8',
    );
    writeFileSync(
      join(cursorDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { mystery: { command: 'custom' } } }),
      'utf8',
    );

    const sources = readConfiguredMcpSources(tmpHome);
    const map = discoverMcpCapabilities({ sources });

    expect(sources.map((source) => source.id)).toEqual(['codex', 'claude-code', 'cursor']);
    expect(map.servers.github?.categories).toContain('git/github');
    expect(map.servers.colony?.categories).toContain('coordination');
    expect(map.servers.mystery?.categories).toEqual(['unknown']);
  });

  it('keeps unrecognized servers non-fatal', () => {
    expect(classifyMcpServer('vendor-x', { command: 'vendor-x-mcp' })).toEqual({
      categories: ['unknown'],
      capabilities: ['unknown'],
    });
  });
});
