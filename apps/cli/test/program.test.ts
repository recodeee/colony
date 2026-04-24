import { describe, expect, it } from 'vitest';
import { createProgram } from '../src/index.js';

describe('Colony CLI program', () => {
  it('registers every top-level command', () => {
    const program = createProgram();
    const names = program.commands.map((c) => c.name()).sort();
    const expected = [
      'backfill',
      'compress',
      'config',
      'debrief',
      'doctor',
      'expand',
      'export',
      'foraging',
      'hook',
      'import',
      'install',
      'mcp',
      'note',
      'observe',
      'reindex',
      'restart',
      'search',
      'start',
      'status',
      'stop',
      'uninstall',
      'viewer',
      'worker',
    ].sort();
    expect(names).toEqual(expected);
  });

  it('the install command accepts --ide', () => {
    const program = createProgram();
    const install = program.commands.find((c) => c.name() === 'install');
    expect(install).toBeDefined();
    const ide = install?.options.find((o) => o.long === '--ide');
    expect(ide?.defaultValue).toBe('claude-code');
  });

  it('exposes a hook subcommand with a `run` action', () => {
    const program = createProgram();
    const hook = program.commands.find((c) => c.name() === 'hook');
    expect(hook).toBeDefined();
    expect(hook?.commands.map((c) => c.name())).toContain('run');
  });

  it('advertises a semantic version', () => {
    const program = createProgram();
    expect(program.version()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('exposes foraging scan/list/clear subcommands', () => {
    const program = createProgram();
    const foraging = program.commands.find((c) => c.name() === 'foraging');
    expect(foraging).toBeDefined();
    const subs = foraging?.commands.map((c) => c.name()).sort() ?? [];
    expect(subs).toEqual(['clear', 'list', 'scan']);
    const scan = foraging?.commands.find((c) => c.name() === 'scan');
    expect(scan?.options.find((o) => o.long === '--cwd')).toBeDefined();
    const clear = foraging?.commands.find((c) => c.name() === 'clear');
    expect(clear?.options.find((o) => o.long === '--example')).toBeDefined();
  });
});
