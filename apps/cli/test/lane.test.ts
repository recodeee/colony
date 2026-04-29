import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings } from '@colony/config';
import { TaskThread } from '@colony/core';
import kleur from 'kleur';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../src/index.js';
import { withStore } from '../src/util/store.js';

let dataDir: string;
let output: string;
let originalColonyHome: string | undefined;

beforeEach(() => {
  kleur.enabled = false;
  dataDir = mkdtempSync(join(tmpdir(), 'colony-cli-lane-data-'));
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

describe('colony lane CLI', () => {
  it('pauses and resumes a lane with audit observations', async () => {
    await createProgram().parseAsync(
      [
        'node',
        'test',
        'lane',
        'pause',
        'codex@old',
        '--requester',
        'human:ops',
        '--reason',
        'contention',
      ],
      { from: 'node' },
    );

    expect(output).toContain('paused lane codex@old by human:ops');
    const settings = loadSettings();
    await withStore(settings, (store) => {
      expect(store.storage.getLaneState('codex@old')).toMatchObject({
        state: 'paused',
        reason: 'contention',
        updated_by_session_id: 'human:ops',
      });
      expect(store.storage.timeline('human:ops').map((row) => row.kind)).toContain('lane-pause');
    });

    output = '';
    await createProgram().parseAsync(
      [
        'node',
        'test',
        'lane',
        'resume',
        'codex@old',
        '--requester',
        'human:ops',
        '--reason',
        'returned',
      ],
      { from: 'node' },
    );

    expect(output).toContain('resumed lane codex@old by human:ops');
    await withStore(settings, (store) => {
      expect(store.storage.getLaneState('codex@old')).toMatchObject({
        state: 'active',
        reason: 'returned',
      });
      expect(store.storage.listPausedLanes()).toHaveLength(0);
      expect(store.storage.timeline('human:ops').map((row) => row.kind)).toContain('lane-resume');
    });
  });

  it('takes over a claimed file and leaves weak-old-claim audit history', async () => {
    const settings = loadSettings();
    await withStore(settings, (store) => {
      store.startSession({ id: 'codex@old', ide: 'codex', cwd: '/repo' });
      store.startSession({ id: 'human:ops', ide: 'human', cwd: '/repo' });
      const thread = TaskThread.open(store, {
        repo_root: '/repo',
        branch: 'agent/codex/contention',
        title: 'contention lane',
        session_id: 'codex@old',
      });
      thread.join('codex@old', 'codex');
      thread.claimFile({ session_id: 'codex@old', file_path: 'src/shared.ts' });
    });

    await createProgram().parseAsync(
      [
        'node',
        'test',
        'lane',
        'takeover',
        'codex@old',
        '--file',
        'src/shared.ts',
        '--reason',
        'manual contention resolution',
        '--requester',
        'human:ops',
      ],
      { from: 'node' },
    );

    expect(output).toContain('takeover recorded');
    await withStore(settings, (store) => {
      const task = store.storage.findTaskByBranch('/repo', 'agent/codex/contention');
      expect(task).toBeDefined();
      expect(store.storage.getClaim(task?.id ?? 0, 'src/shared.ts')?.session_id).toBe('human:ops');
      expect(store.storage.taskObservationsByKind(task?.id ?? 0, 'claim-weakened')).toHaveLength(1);
      expect(store.storage.taskObservationsByKind(task?.id ?? 0, 'lane-takeover')).toHaveLength(1);
    });
  });
});
