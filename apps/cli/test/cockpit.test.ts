import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import kleur from 'kleur';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../src/index.js';
import {
  buildGitGuardexCockpitCommand,
  defaultCockpitSessionName,
  formatCommand,
} from '../src/lib/gitguardex.js';

let dataDir: string;
let output: string;
let originalColonyHome: string | undefined;

beforeEach(() => {
  kleur.enabled = false;
  dataDir = mkdtempSync(join(tmpdir(), 'colony-cockpit-data-'));
  originalColonyHome = process.env.COLONY_HOME;
  process.env.COLONY_HOME = dataDir;
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
  if (originalColonyHome === undefined) delete process.env.COLONY_HOME;
  else process.env.COLONY_HOME = originalColonyHome;
  kleur.enabled = true;
});

describe('colony cockpit', () => {
  it('renders the default gx cockpit command for the current repo in dry-run mode', async () => {
    await createProgram().parseAsync(
      ['node', 'test', 'cockpit', '--dry-run', '--repo-root', '/work/colony'],
      { from: 'node' },
    );

    expect(output).toContain('gitguardex cockpit dry-run');
    expect(output).toContain('command: gx cockpit --target /work/colony --session colony-colony');
    expect(output).toContain('next ready spawn commands:');
    expect(output).toContain('no ready Colony plan subtasks');
  });

  it('emits structured dry-run output with explicit session values', async () => {
    await createProgram().parseAsync(
      [
        'node',
        'test',
        'cockpit',
        '--dry-run',
        '--json',
        '--repo-root',
        '/work/colony',
        '--session',
        'ops',
        '--agent',
        'claude',
        '--base',
        'dev',
      ],
      { from: 'node' },
    );

    expect(JSON.parse(output)).toMatchObject({
      dry_run: true,
      command: 'gx cockpit --target /work/colony --session ops',
      repo_root: '/work/colony',
      session_name: 'ops',
      next_spawn_commands: [],
    });
  });

  it('quotes rendered paths and sessions for shell output', () => {
    expect(
      formatCommand('gx', buildGitGuardexCockpitCommand('/work/repo with space', 'ops cockpit')),
    ).toBe("gx cockpit --target '/work/repo with space' --session 'ops cockpit'");
  });

  it('normalizes the default session name from the repo root', () => {
    expect(defaultCockpitSessionName('/work/Colony Repo')).toBe('colony-colony-repo');
  });

  it('validates the displayed agent value used for follow-up spawn commands', async () => {
    await expect(
      createProgram().parseAsync(
        [
          'node',
          'test',
          'cockpit',
          '--dry-run',
          '--repo-root',
          '/work/colony',
          '--agent',
          'medusa',
        ],
        { from: 'node' },
      ),
    ).rejects.toThrow('--agent must be codex or claude, got medusa');
  });
});
