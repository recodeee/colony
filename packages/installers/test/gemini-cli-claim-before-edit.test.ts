import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { geminiCli } from '../src/gemini-cli.js';
import type { InstallContext } from '../src/types.js';

let home: string;
let originalHome: string | undefined;
let ctx: InstallContext;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'colony-gemini-claim-'));
  originalHome = process.env.HOME;
  process.env.HOME = home;
  ctx = {
    ideConfigDir: home,
    cliPath: '/fake/bin/colony.js',
    nodeBin: '/fake/bin/node',
    dataDir: join(home, '.colony'),
  };
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe('gemini-cli claim-before-edit installer smoke', () => {
  it('installs the Colony MCP server without pretending Gemini CLI has lifecycle hooks', async () => {
    const settingsPath = join(home, '.gemini', 'settings.json');
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        contextFiles: ['GEMINI.md'],
        mcpServers: {
          other: { command: '/other/bin' },
          cavemem: { command: '/old/bin', args: ['old-mcp'] },
        },
      }),
    );

    await geminiCli.install(ctx);

    expect(existsSync(settingsPath)).toBe(true);
    const installed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      contextFiles?: string[];
      hooks?: unknown;
      mcpServers: Record<string, { command: string; args?: string[] }>;
    };
    expect(installed.contextFiles).toEqual(['GEMINI.md']);
    expect(installed.mcpServers.other).toEqual({ command: '/other/bin' });
    expect(installed.mcpServers.colony).toEqual({
      command: ctx.nodeBin,
      args: [ctx.cliPath, 'mcp'],
    });
    expect(installed.mcpServers.cavemem).toBeUndefined();
    expect(installed.hooks).toBeUndefined();
    expect(JSON.stringify(installed)).not.toContain('pre-tool-use');
    expect(JSON.stringify(installed)).not.toContain('claim-before-edit');
  });
});
