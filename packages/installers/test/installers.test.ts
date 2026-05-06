import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { quotaSafeOperatingContract } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCode } from '../src/claude-code.js';
import { codex, validateCodexInstall } from '../src/codex.js';
import { cursor } from '../src/cursor.js';
import { deepMerge } from '../src/fs-utils.js';
import { getInstaller, installers } from '../src/registry.js';
import type { InstallContext } from '../src/types.js';

let home: string;
let originalHome: string | undefined;
let ctx: InstallContext;
const WRITE_TOOL_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit|Bash|apply_patch|ApplyPatch|Patch';
const QUOTA_SAFE_CONTRACT_TERMS = [
  'hivemind_context',
  'attention_inbox',
  'task_ready_for_agent',
  'task_accept_handoff',
  'task_plan_claim_subtask',
  'task_claim_file',
  'task_note_working',
  'quota_exhausted',
  'task_hand_off',
  'task_relay',
  'release owned claims',
  'claimed files',
  'dirty files',
  'last verification',
  'Shutdown / finish contract',
  'run git status',
  'commit finished work',
  'hand off unfinished work',
  'clean intentionally abandoned edits',
  'Release or weaken claims',
  'handoff-pending',
  'coordination sweep guidance',
  'Colony',
  'OMX',
  'MCP servers',
  'RTK command policy',
  'Always prefix shell commands with `rtk`',
  'rtk git status',
  'rtk gh pr view',
  'rtk proxy <command>',
  'If `rtk` is unavailable',
];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'colony-ins-'));
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

describe('registry', () => {
  it('exposes all expected installers', () => {
    expect(Object.keys(installers).sort()).toEqual(
      ['claude-code', 'codex', 'cursor', 'gemini-cli', 'opencode'].sort(),
    );
  });
  it('getInstaller throws on unknown id', () => {
    expect(() => getInstaller('nope')).toThrow(/Unknown IDE/);
  });
});

describe('deepMerge', () => {
  it('recursively merges nested objects', () => {
    const a: Record<string, unknown> = { a: { b: 1, c: 2 }, d: 3 };
    const b: Record<string, unknown> = { a: { c: 20, e: 5 }, f: 6 };
    expect(deepMerge(a, b)).toEqual({
      a: { b: 1, c: 20, e: 5 },
      d: 3,
      f: 6,
    });
  });
  it('replaces arrays instead of concatenating', () => {
    const base: Record<string, unknown> = { xs: [1, 2] };
    const add: Record<string, unknown> = { xs: [3] };
    expect(deepMerge(base, add)).toEqual({ xs: [3] });
  });
});

describe('claude-code installer', () => {
  it('wires SessionStart to generated quota-safe instructions', async () => {
    await claudeCode.install(ctx);
    const settingsPath = join(home, '.claude', 'settings.json');
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      mcpServers: Record<string, { command: string; args?: string[] }>;
    };

    expect(parsed.hooks.SessionStart?.[0]?.hooks?.[0]?.command).toBe(
      `${ctx.nodeBin} ${ctx.cliPath} hook run session-start --ide claude-code`,
    );
    expect(parsed.mcpServers.colony).toEqual({ command: ctx.nodeBin, args: [ctx.cliPath, 'mcp'] });
    for (const term of QUOTA_SAFE_CONTRACT_TERMS) {
      expect(quotaSafeOperatingContract).toContain(term);
    }
  });

  it('writes hooks + mcpServer for a fresh install and is idempotent', async () => {
    await claudeCode.install(ctx);
    const settingsPath = join(home, '.claude', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);
    const first = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<
        string,
        Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>
      >;
      mcpServers: Record<string, { command: string; args?: string[] }>;
    };
    expect(Object.keys(first.hooks).sort()).toEqual(
      [
        'PostToolUse',
        'PreToolUse',
        'SessionEnd',
        'SessionStart',
        'Stop',
        'UserPromptSubmit',
      ].sort(),
    );
    expect(first.hooks.SessionStart?.[0]?.hooks?.[0]?.command).toBe(
      `${ctx.nodeBin} ${ctx.cliPath} hook run session-start --ide claude-code`,
    );
    expect(first.hooks.SessionStart?.[0]?.matcher).toBeUndefined();
    expect(first.hooks.PreToolUse?.[0]?.hooks?.[0]?.command).toBe(
      `${ctx.nodeBin} ${ctx.cliPath} hook run pre-tool-use --ide claude-code`,
    );
    // PreToolUse and PostToolUse run our auto-claim path; scope them to the
    // tool calls that actually touch files so unrelated tools don't pay the
    // hook cost and so claim-before-edit telemetry has clean coverage.
    expect(first.hooks.PreToolUse?.[0]?.matcher).toBe(WRITE_TOOL_MATCHER);
    expect(first.hooks.PostToolUse?.[0]?.hooks?.[0]?.command).toBe(
      `${ctx.nodeBin} ${ctx.cliPath} hook run post-tool-use --ide claude-code`,
    );
    expect(first.hooks.PostToolUse?.[0]?.matcher).toBe(WRITE_TOOL_MATCHER);
    expect(first.mcpServers.colony).toEqual({
      command: ctx.nodeBin,
      args: [ctx.cliPath, 'mcp'],
    });

    await claudeCode.install(ctx); // run twice
    const second = JSON.parse(readFileSync(settingsPath, 'utf8')) as typeof first;
    expect(Object.keys(second.hooks).sort()).toEqual(Object.keys(first.hooks).sort());
    expect(second.hooks.SessionStart).toHaveLength(1);
    // No duplicate or stale MCP namespace entries.
    expect(Object.keys(second.mcpServers)).toEqual(['colony']);
  });

  it('preserves unrelated user settings on install + uninstall', async () => {
    const settingsPath = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        theme: 'dark',
        mcpServers: {
          other: { command: '/other/bin' },
          cavemem: { command: '/old/bin', args: ['old-mcp'] },
        },
        hooks: {
          CustomEvent: [{ hooks: [{ type: 'command', command: 'noop' }] }],
          PostToolUse: [
            {
              matcher: '*',
              hooks: [{ type: 'command', command: 'node /home/me/.claude/hooks/context.js' }],
            },
            {
              hooks: [
                {
                  type: 'command',
                  command: '/old/bin/colony hook run post-tool-use --ide claude-code',
                },
              ],
            },
          ],
        },
      }),
    );

    await claudeCode.install(ctx);
    const installed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      theme: string;
      hooks: Record<string, unknown>;
      mcpServers: Record<string, unknown>;
    };
    expect(installed.theme).toBe('dark');
    expect(installed.mcpServers.other).toEqual({ command: '/other/bin' });
    expect(installed.mcpServers.colony).toEqual({
      command: ctx.nodeBin,
      args: [ctx.cliPath, 'mcp'],
    });
    expect(installed.mcpServers.cavemem).toBeUndefined();
    expect(installed.hooks.CustomEvent).toBeDefined();
    expect(installed.hooks.PostToolUse).toEqual([
      {
        matcher: '*',
        hooks: [{ type: 'command', command: 'node /home/me/.claude/hooks/context.js' }],
      },
      {
        matcher: WRITE_TOOL_MATCHER,
        hooks: [
          {
            type: 'command',
            command: `${ctx.nodeBin} ${ctx.cliPath} hook run post-tool-use --ide claude-code`,
          },
        ],
      },
    ]);

    await claudeCode.uninstall(ctx);
    const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as typeof installed;
    expect(after.theme).toBe('dark');
    expect(after.mcpServers.other).toEqual({ command: '/other/bin' });
    expect(after.mcpServers.colony).toBeUndefined();
    expect(after.mcpServers.cavemem).toBeUndefined();
    expect(after.hooks.SessionStart).toBeUndefined();
    expect(after.hooks.CustomEvent).toBeDefined();
    expect(after.hooks.PostToolUse).toEqual([
      {
        matcher: '*',
        hooks: [{ type: 'command', command: 'node /home/me/.claude/hooks/context.js' }],
      },
    ]);
  });

  it('quotes paths with spaces in hook command strings (Windows)', async () => {
    const winCtx: InstallContext = {
      ideConfigDir: home,
      cliPath: 'C:\\Users\\Some User\\AppData\\Roaming\\npm\\node_modules\\colony\\dist\\index.js',
      nodeBin: 'C:\\Program Files\\nodejs\\node.exe',
      dataDir: join(home, '.colony'),
    };
    await claudeCode.install(winCtx);
    const settingsPath = join(home, '.claude', 'settings.json');
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const cmd = parsed.hooks.SessionStart?.[0]?.hooks?.[0]?.command ?? '';
    expect(cmd).toBe(
      `"${winCtx.nodeBin}" "${winCtx.cliPath}" hook run session-start --ide claude-code`,
    );
    // MCP entry is a structured shape, so no quoting needed there — Claude
    // spawns command + args directly.
    expect(parsed.mcpServers.colony).toEqual({
      command: winCtx.nodeBin,
      args: [winCtx.cliPath, 'mcp'],
    });
  });

  it('detect returns true only when ~/.claude exists', async () => {
    expect(await claudeCode.detect(ctx)).toBe(false);
    mkdirSync(join(home, '.claude'));
    expect(await claudeCode.detect(ctx)).toBe(true);
  });
});

describe('codex installer', () => {
  it('wires SessionStart to generated quota-safe instructions', async () => {
    await codex.install(ctx);
    const configPath = join(home, '.codex', 'config.json');
    const hooksPath = join(home, '.codex', 'hooks.json');
    const hooks = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      mcpServers: Record<string, { command: string; args?: string[] }>;
    };

    expect(hooks.hooks.SessionStart?.[0]?.matcher).toBe('startup|resume');
    expect(hooks.hooks.SessionStart?.[0]?.hooks?.[0]?.command).toBe(
      `${ctx.nodeBin} ${ctx.cliPath} hook run session-start --ide codex`,
    );
    expect(config.mcpServers.colony).toEqual({ command: ctx.nodeBin, args: [ctx.cliPath, 'mcp'] });
    for (const term of QUOTA_SAFE_CONTRACT_TERMS) {
      expect(quotaSafeOperatingContract).toContain(term);
    }
  });

  it('writes hooks + mcpServer for a fresh install and is idempotent', async () => {
    await codex.install(ctx);
    const configPath = join(home, '.codex', 'config.json');
    const hooksPath = join(home, '.codex', 'hooks.json');
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(hooksPath)).toBe(true);
    const first = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
      hooks: Record<
        string,
        Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>
      >;
    };
    expect(Object.keys(first.hooks).sort()).toEqual(
      ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort(),
    );
    expect(first.hooks.SessionStart?.[0]?.matcher).toBe('startup|resume');
    expect(first.hooks.SessionStart?.[0]?.hooks?.[0]?.command).toBe(
      `${ctx.nodeBin} ${ctx.cliPath} hook run session-start --ide codex`,
    );
    expect(first.hooks.PreToolUse?.[0]?.matcher).toBe(WRITE_TOOL_MATCHER);
    expect(first.hooks.PreToolUse?.[0]?.hooks?.[0]?.command).toBe(
      `${ctx.nodeBin} ${ctx.cliPath} hook run pre-tool-use --ide codex`,
    );
    expect(first.hooks.PostToolUse?.[0]?.matcher).toBe(WRITE_TOOL_MATCHER);
    expect(first.hooks.PostToolUse?.[0]?.hooks?.[0]?.command).toBe(
      `${ctx.nodeBin} ${ctx.cliPath} hook run post-tool-use --ide codex`,
    );
    expect(first.hooks.UserPromptSubmit?.[0]?.hooks?.[0]?.command).toBe(
      `${ctx.nodeBin} ${ctx.cliPath} hook run user-prompt-submit --ide codex`,
    );
    expect(first.hooks.Stop?.[0]?.hooks?.[0]?.command).toBe(
      `${ctx.nodeBin} ${ctx.cliPath} hook run stop --ide codex`,
    );

    await codex.install(ctx);
    const second = JSON.parse(readFileSync(hooksPath, 'utf8')) as typeof first;
    expect(Object.keys(second.hooks).sort()).toEqual(Object.keys(first.hooks).sort());
    expect(second.hooks.PreToolUse).toHaveLength(1);
    expect(second.hooks.PostToolUse).toHaveLength(1);
    expect(second.hooks.SessionStart).toHaveLength(1);
    expect(second.hooks.UserPromptSubmit).toHaveLength(1);
    expect(second.hooks.Stop).toHaveLength(1);
    expect(validateCodexInstall(ctx)).toMatchObject({
      ok: true,
      issues: [],
      messages: expect.arrayContaining([expect.stringContaining(`verified ${hooksPath}`)]),
    });
  });

  it('reports exact Codex hook file and missing/stale hooks during verification', async () => {
    const configPath = join(home, '.codex', 'config.json');
    const hooksPath = join(home, '.codex', 'hooks.json');
    mkdirSync(dirname(hooksPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          colony: { command: ctx.nodeBin, args: [ctx.cliPath, 'mcp'] },
        },
      }),
    );
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Edit|Write',
              hooks: [
                { type: 'command', command: '/old/colony hook run pre-tool-use --ide codex' },
              ],
            },
          ],
        },
      }),
    );

    const result = await codex.verify?.(ctx);
    expect(result).toMatchObject({
      ok: false,
      issues: [
        {
          file: hooksPath,
          missingHooks: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'],
          staleHooks: ['PreToolUse'],
        },
      ],
    });
  });

  it('preserves unrelated Codex hooks and removes stale Colony hooks', async () => {
    const hooksPath = join(home, '.codex', 'hooks.json');
    mkdirSync(dirname(hooksPath), { recursive: true });
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'node /custom/codex-hook.js' }],
            },
            {
              matcher: 'Edit|Write',
              hooks: [
                { type: 'command', command: '/old/colony hook run pre-tool-use --ide codex' },
              ],
            },
          ],
          PostToolUse: [
            {
              matcher: 'Edit|Write',
              hooks: [
                {
                  type: 'command',
                  command:
                    '/old/bin/node /old/apps/cli/dist/index.js hook run post-tool-use --ide codex',
                },
              ],
            },
          ],
        },
      }),
    );

    await codex.install(ctx);
    const installed = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
      hooks: Record<string, unknown>;
    };
    expect(installed.hooks.PreToolUse).toEqual([
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'node /custom/codex-hook.js' }],
      },
      {
        matcher: WRITE_TOOL_MATCHER,
        hooks: [
          {
            type: 'command',
            command: `${ctx.nodeBin} ${ctx.cliPath} hook run pre-tool-use --ide codex`,
          },
        ],
      },
    ]);
    expect(installed.hooks.PostToolUse).toEqual([
      {
        matcher: WRITE_TOOL_MATCHER,
        hooks: [
          {
            type: 'command',
            command: `${ctx.nodeBin} ${ctx.cliPath} hook run post-tool-use --ide codex`,
          },
        ],
      },
    ]);

    await codex.uninstall(ctx);
    const after = JSON.parse(readFileSync(hooksPath, 'utf8')) as typeof installed;
    expect(after.hooks.PreToolUse).toEqual([
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'node /custom/codex-hook.js' }],
      },
    ]);
    expect(after.hooks.PostToolUse).toBeUndefined();
  });
});

describe('cursor installer', () => {
  it('writes a cursor MCP config and removes it cleanly', async () => {
    await cursor.install(ctx);
    const p = join(home, '.cursor', 'mcp.json');
    expect(existsSync(p)).toBe(true);
    const cfg = JSON.parse(readFileSync(p, 'utf8')) as {
      mcpServers: Record<string, { command: string; args?: string[] }>;
    };
    expect(cfg.mcpServers.colony).toEqual({
      command: ctx.nodeBin,
      args: [ctx.cliPath, 'mcp'],
    });

    await cursor.uninstall(ctx);
    const after = JSON.parse(readFileSync(p, 'utf8')) as typeof cfg;
    expect(after.mcpServers.colony).toBeUndefined();
    expect(after.mcpServers.colony).toBeUndefined();
  });
});

describe('MCP namespace installers', () => {
  const cases = [
    ['codex', ['.codex', 'config.json']],
    ['gemini-cli', ['.gemini', 'settings.json']],
    ['opencode', ['.opencode', 'config.json']],
  ] as const;

  for (const [installerId, pathParts] of cases) {
    it(`${installerId} writes colony and removes stale cavemem`, async () => {
      const p = join(home, ...pathParts);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(
        p,
        JSON.stringify({
          mcpServers: {
            other: { command: '/other/bin' },
            cavemem: { command: '/old/bin', args: ['old-mcp'] },
          },
        }),
      );

      const installer = getInstaller(installerId);
      await installer.install(ctx);
      const installed = JSON.parse(readFileSync(p, 'utf8')) as {
        mcpServers: Record<string, { command: string; args?: string[] }>;
      };
      expect(installed.mcpServers.other).toEqual({ command: '/other/bin' });
      expect(installed.mcpServers.colony).toEqual({
        command: ctx.nodeBin,
        args: [ctx.cliPath, 'mcp'],
      });
      expect(installed.mcpServers.cavemem).toBeUndefined();

      await installer.uninstall(ctx);
      const after = JSON.parse(readFileSync(p, 'utf8')) as typeof installed;
      expect(after.mcpServers.other).toEqual({ command: '/other/bin' });
      expect(after.mcpServers.colony).toBeUndefined();
      expect(after.mcpServers.cavemem).toBeUndefined();
    });
  }

  it('copies a detected system OMX MCP layer into target IDE configs', async () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      join(home, '.codex', 'config.toml'),
      [
        '[mcp_servers.omx_state]',
        'command = "node"',
        'args = ["/opt/oh-my-codex/dist/mcp/state-server.js"]',
        '',
        '[mcp_servers.omx_memory]',
        'command = "node"',
        'args = ["/opt/oh-my-codex/dist/mcp/memory-server.js"]',
        '',
        '[mcp_servers.omx_memory.env]',
        'OMX_HOME = "/tmp/omx-home"',
        '',
        '[mcp_servers.filesystem]',
        'command = "mcp-server-filesystem"',
        'args = ["/repo"]',
      ].join('\n'),
    );

    for (const [installerId, pathParts] of cases) {
      const installer = getInstaller(installerId);
      const messages = await installer.install(ctx);
      const installed = JSON.parse(readFileSync(join(home, ...pathParts), 'utf8')) as {
        mcpServers: Record<
          string,
          { command: string; args?: string[]; env?: Record<string, string> }
        >;
      };

      expect(messages).toContain('installed detected OMX MCP layer: omx_memory, omx_state');
      expect(installed.mcpServers.colony).toEqual({
        command: ctx.nodeBin,
        args: [ctx.cliPath, 'mcp'],
      });
      expect(installed.mcpServers.omx_state).toEqual({
        command: 'node',
        args: ['/opt/oh-my-codex/dist/mcp/state-server.js'],
      });
      expect(installed.mcpServers.omx_memory).toEqual({
        command: 'node',
        args: ['/opt/oh-my-codex/dist/mcp/memory-server.js'],
        env: { OMX_HOME: '/tmp/omx-home' },
      });
      expect(installed.mcpServers.filesystem).toBeUndefined();
    }
  });

  it('preserves an existing target OMX MCP override', async () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(
      join(home, '.codex', 'config.toml'),
      [
        '[mcp_servers.omx_state]',
        'command = "node"',
        'args = ["/opt/oh-my-codex/dist/mcp/state-server.js"]',
      ].join('\n'),
    );
    writeFileSync(
      join(home, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          omx_state: { command: '/custom/node', args: ['/custom/omx-state.js'] },
        },
      }),
    );

    await cursor.install(ctx);
    const installed = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string; args?: string[] }>;
    };

    expect(installed.mcpServers.omx_state).toEqual({
      command: '/custom/node',
      args: ['/custom/omx-state.js'],
    });
    expect(installed.mcpServers.colony).toEqual({
      command: ctx.nodeBin,
      args: [ctx.cliPath, 'mcp'],
    });
  });
});
