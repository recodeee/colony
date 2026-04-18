import { describe, expect, it } from 'vitest';
import { createProgram } from '../src/index.js';

describe('cavemem CLI program', () => {
  it('registers every top-level command', () => {
    const program = createProgram();
    const names = program.commands.map((c) => c.name()).sort();
    const expected = [
      'compress',
      'config',
      'doctor',
      'expand',
      'export',
      'hook',
      'import',
      'install',
      'mcp',
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
    for (const name of expected) {
      expect(names).toContain(name);
    }
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
});
