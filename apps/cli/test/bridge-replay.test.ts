import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSettings } from '@colony/config';
import { MemoryStore } from '@colony/core';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Replay subcommand keeps the live SQLite untouched unless the operator opts in
// with --apply. The first three tests pin that behavior; the smoke test loads a
// real fixture through the un-mocked runOmxLifecycleEnvelope to guard against
// shape drift in the envelope parser.

const mocks = vi.hoisted(() => ({
  loadSettings: vi.fn(() => ({ fileHeatHalfLifeMinutes: 120 })),
  withStore: vi.fn(async (_settings: unknown, run: (store: unknown) => unknown) =>
    run({ kind: 'store' }),
  ),
  runOmxLifecycleEnvelope: vi.fn(),
}));

vi.mock('@colony/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@colony/config')>();
  return {
    ...actual,
    loadSettings: mocks.loadSettings,
  };
});

vi.mock('../src/util/store.js', () => ({
  withStore: mocks.withStore,
}));

import { registerBridgeCommand } from '../src/commands/bridge.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE_DIR = resolvePath(
  HERE,
  '..',
  '..',
  '..',
  'packages',
  'contracts',
  'fixtures',
  'colony-omx-lifecycle-v1',
);

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('bridge replay <file>', () => {
  it('defaults to dry-run: uses the injected ephemeral store and reports applied=false', async () => {
    const envelope = {
      event_id: 'evt_replay_dry',
      event_name: 'pre_tool_use',
      session_id: 'codex@replay',
      agent: 'codex',
      cwd: '/repo',
      repo_root: '/repo',
      branch: 'main',
      timestamp: '2026-04-29T10:01:00.000Z',
      source: 'omx',
      tool_name: 'Write',
      tool_input: { file_path: '/repo/foo.ts' },
    };
    const readReplayFile = vi.fn((path: string) => {
      expect(path).toBe(resolvePath(process.cwd(), '/tmp/saved.pre.json'));
      return JSON.stringify(envelope);
    });
    const cleanup = vi.fn();
    const createDryRunStore = vi.fn(() => ({
      store: { kind: 'ephemeral-store' } as unknown as MemoryStore,
      cleanup,
    }));
    mocks.runOmxLifecycleEnvelope.mockResolvedValue({
      ok: true,
      ms: 4,
      event_id: 'evt_replay_dry',
      event_type: 'pre_tool_use',
      route: 'pre-tool-use',
    });
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    const program = new Command();
    registerBridgeCommand(program, {
      readReplayFile,
      createDryRunStore,
      runOmxLifecycleEnvelope: mocks.runOmxLifecycleEnvelope,
    });

    await program.parseAsync(
      ['node', 'test', 'bridge', 'replay', '/tmp/saved.pre.json', '--json'],
      { from: 'node' },
    );

    expect(readReplayFile).toHaveBeenCalledTimes(1);
    expect(createDryRunStore).toHaveBeenCalledTimes(1);
    expect(mocks.runOmxLifecycleEnvelope).toHaveBeenCalledWith(
      envelope,
      expect.objectContaining({ store: { kind: 'ephemeral-store' } }),
    );
    expect(cleanup).toHaveBeenCalledTimes(1);

    const parsed = JSON.parse(output.join(''));
    expect(parsed).toMatchObject({
      ok: true,
      event_type: 'pre_tool_use',
      route: 'pre-tool-use',
      replay: true,
      applied: false,
      input_path: resolvePath(process.cwd(), '/tmp/saved.pre.json'),
    });
  });

  it('with --apply skips the dry-run store and writes against the live store', async () => {
    const envelope = {
      event_id: 'evt_replay_apply',
      event_name: 'task_bind',
      session_id: 'codex@replay',
      agent: 'codex',
      cwd: '/repo',
      repo_root: '/repo',
      branch: 'main',
      timestamp: '2026-04-29T10:01:00.000Z',
      source: 'omx',
    };
    const readReplayFile = vi.fn(() => JSON.stringify(envelope));
    const cleanup = vi.fn();
    const createDryRunStore = vi.fn(() => ({
      store: { kind: 'ephemeral-store' } as unknown as MemoryStore,
      cleanup,
    }));
    mocks.runOmxLifecycleEnvelope.mockResolvedValue({
      ok: true,
      ms: 2,
      event_id: 'evt_replay_apply',
      event_type: 'task_bind',
      route: 'task_bind',
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    const program = new Command();
    registerBridgeCommand(program, {
      readReplayFile,
      createDryRunStore,
      runOmxLifecycleEnvelope: mocks.runOmxLifecycleEnvelope,
    });

    await program.parseAsync(
      ['node', 'test', 'bridge', 'replay', '/tmp/apply.pre.json', '--apply'],
      { from: 'node' },
    );

    expect(createDryRunStore).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(mocks.runOmxLifecycleEnvelope).toHaveBeenCalledWith(
      envelope,
      expect.not.objectContaining({ store: expect.anything() }),
    );
    expect(stderr.join('')).toContain('applying to live store');
    expect(stdout.join('')).toContain('replay=true applied=true');
  });

  it('--rewrite-root rewrites absolute paths in the envelope before dispatch', async () => {
    const envelope = {
      event_id: 'evt_replay_rewrite',
      event_name: 'pre_tool_use',
      session_id: 'codex@replay',
      agent: 'codex',
      cwd: '/workspace/colony',
      repo_root: '/workspace/colony',
      branch: 'main',
      timestamp: '2026-04-29T10:01:00.000Z',
      source: 'omx',
      tool_name: 'Write',
      tool_input: { file_path: '/workspace/colony/packages/foo.ts' },
    };
    const readReplayFile = vi.fn(() => JSON.stringify(envelope));
    const createDryRunStore = vi.fn(() => ({
      store: { kind: 'ephemeral-store' } as unknown as MemoryStore,
      cleanup: vi.fn(),
    }));
    mocks.runOmxLifecycleEnvelope.mockResolvedValue({
      ok: true,
      ms: 1,
      event_id: 'evt_replay_rewrite',
      event_type: 'pre_tool_use',
      route: 'pre-tool-use',
    });

    const program = new Command();
    registerBridgeCommand(program, {
      readReplayFile,
      createDryRunStore,
      runOmxLifecycleEnvelope: mocks.runOmxLifecycleEnvelope,
    });

    await program.parseAsync(
      [
        'node',
        'test',
        'bridge',
        'replay',
        '/tmp/saved.pre.json',
        '--json',
        '--rewrite-root',
        '/workspace/colony=/tmp/repo',
      ],
      { from: 'node' },
    );

    expect(mocks.runOmxLifecycleEnvelope).toHaveBeenCalledTimes(1);
    const calledWith = mocks.runOmxLifecycleEnvelope.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(calledWith.cwd).toBe('/tmp/repo');
    expect(calledWith.repo_root).toBe('/tmp/repo');
    expect((calledWith.tool_input as Record<string, unknown>).file_path).toBe(
      '/tmp/repo/packages/foo.ts',
    );
    // Non-matching prefixes are left alone.
    expect(calledWith.session_id).toBe('codex@replay');
  });

  it('smoke: drives a real fixture through the un-mocked envelope runner with an ephemeral store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'colony-bridge-replay-smoke-'));
    const store = new MemoryStore({
      dbPath: join(dir, 'data.db'),
      settings: defaultSettings,
    });
    try {
      const fixturePath = join(FIXTURE_DIR, 'codex-write.pre.json');
      const raw = readFileSync(fixturePath, 'utf8');
      const envelope = JSON.parse(raw);
      const { runOmxLifecycleEnvelope } = await import('@colony/hooks');
      const result = await runOmxLifecycleEnvelope(envelope, { store });
      expect(result.ok).toBe(true);
      expect(result.event_type).toBe('pre_tool_use');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
