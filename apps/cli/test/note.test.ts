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
let repoRoot: string;
let output: string;
let originalColonyHome: string | undefined;
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  kleur.enabled = false;
  dataDir = mkdtempSync(join(tmpdir(), 'colony-cli-note-data-'));
  repoRoot = mkdtempSync(join(tmpdir(), 'colony-cli-note-repo-'));
  originalColonyHome = process.env.COLONY_HOME;
  originalExitCode = process.exitCode;
  process.env.COLONY_HOME = dataDir;
  process.exitCode = undefined;
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  if (originalColonyHome === undefined) delete process.env.COLONY_HOME;
  else process.env.COLONY_HOME = originalColonyHome;
  process.exitCode = originalExitCode;
  kleur.enabled = true;
});

describe('colony note working', () => {
  it('keeps the existing scratch note command working', async () => {
    await createProgram().parseAsync(['node', 'test', 'note', 'scratch', 'status'], {
      from: 'node',
    });

    expect(output).toContain('note #');
    await withStore(loadSettings(), (store) => {
      const notes = store.storage.listSessions(10);
      expect(notes.some((session) => session.id === 'observer')).toBe(true);
    });
  });

  it('posts a full explicit compact handoff note', async () => {
    const taskId = await seedTask({ title: 'auto handoff notes' });

    await runWorkingNote([
      '--session-id',
      'agent-session',
      '--repo-root',
      repoRoot,
      '--branch',
      'agent/codex/auto-handoff',
      '--task',
      'auto handoff notes',
      '--blocker',
      'none',
      '--next',
      'run focused tests',
      '--evidence',
      'apps/cli/test/note.test.ts',
      '--json',
    ]);

    const payload = JSON.parse(output) as {
      note_text: string;
      task_id: number;
      observation_id: number;
      replaced_previous_working_note: boolean;
      warnings: string[];
    };
    expect(payload).toMatchObject({
      note_text:
        'branch=agent/codex/auto-handoff | task=auto handoff notes | blocker=none | next=run focused tests | evidence=apps/cli/test/note.test.ts',
      task_id: taskId,
      replaced_previous_working_note: false,
      warnings: [],
    });
    await withStore(loadSettings(), (store) => {
      const row = store.storage.getObservation(payload.observation_id);
      const meta = JSON.parse(row?.metadata ?? '{}') as Record<string, unknown>;
      expect(row).toMatchObject({ task_id: taskId, kind: 'note', session_id: 'agent-session' });
      expect(meta).toMatchObject({
        working_note: true,
        auto_handoff_note: true,
        live: true,
        resolved_by: 'colony_note_working',
      });
    });
  });

  it('infers task and branch from the active session binding', async () => {
    const taskId = await seedTask({ title: 'inferred task label' });

    await runWorkingNote([
      '--session-id',
      'agent-session',
      '--repo-root',
      repoRoot,
      '--next',
      'claim touched files',
      '--evidence',
      'hivemind_context',
      '--json',
    ]);

    const payload = JSON.parse(output) as { note_text: string; task_id: number };
    expect(payload.task_id).toBe(taskId);
    expect(payload.note_text).toBe(
      'branch=agent/codex/auto-handoff | task=inferred task label | blocker=none | next=claim touched files | evidence=hivemind_context',
    );
  });

  it('rejects a note missing next', async () => {
    const taskId = await seedTask({ title: 'auto handoff notes' });

    await runWorkingNote([
      '--session-id',
      'agent-session',
      '--repo-root',
      repoRoot,
      '--branch',
      'agent/codex/auto-handoff',
      '--task',
      'auto handoff notes',
      '--evidence',
      'test evidence',
      '--json',
    ]);

    const payload = JSON.parse(output) as { code: string; errors: string[] };
    expect(process.exitCode).toBe(1);
    expect(payload.code).toBe('INVALID_WORKING_HANDOFF_NOTE');
    expect(payload.errors).toContain('missing required field: next');
    await withStore(loadSettings(), (store) => {
      expect(store.storage.taskObservationsByKind(taskId, 'note')).toHaveLength(0);
    });
  });

  it('warns and stores only a compact evidence pointer for long proof dumps', async () => {
    await seedTask({ title: 'auto handoff notes' });

    await runWorkingNote([
      '--session-id',
      'agent-session',
      '--repo-root',
      repoRoot,
      '--next',
      'summarize status',
      '--evidence',
      `${'stack trace line\n'.repeat(30)}SECRET_TAIL_SHOULD_NOT_APPEAR`,
      '--json',
    ]);

    const payload = JSON.parse(output) as {
      note_text: string;
      warnings: string[];
    };
    expect(payload.warnings).toEqual([
      'evidence looks like a long proof/log dump; stored compact pointer only',
    ]);
    expect(payload.note_text).toContain('evidence=stack trace line stack trace line');
    expect(payload.note_text).not.toContain('SECRET_TAIL_SHOULD_NOT_APPEAR');
  });

  it('replaces the previous live working handoff note', async () => {
    const taskId = await seedTask({ title: 'auto handoff notes' });

    await runWorkingNote([
      '--session-id',
      'agent-session',
      '--repo-root',
      repoRoot,
      '--next',
      'first next',
      '--evidence',
      'first evidence',
      '--json',
    ]);
    const first = JSON.parse(output) as { observation_id: number };
    output = '';

    await runWorkingNote([
      '--session-id',
      'agent-session',
      '--repo-root',
      repoRoot,
      '--next',
      'second next',
      '--evidence',
      'second evidence',
      '--json',
    ]);

    const second = JSON.parse(output) as {
      replaced_previous_working_note: boolean;
      previous_working_note_id: number | null;
    };
    expect(second).toMatchObject({
      replaced_previous_working_note: true,
      previous_working_note_id: first.observation_id,
    });

    await withStore(loadSettings(), (store) => {
      const firstRow = store.storage.getObservation(first.observation_id);
      const meta = JSON.parse(firstRow?.metadata ?? '{}') as Record<string, unknown>;
      expect(meta).toMatchObject({
        live: false,
        superseded_by_observation_id: expect.any(Number),
      });
      const live = store.storage
        .taskObservationsByKind(taskId, 'note')
        .filter((row) => TaskThread.isLiveWorkingHandoffMetadata(row.metadata));
      expect(live).toHaveLength(1);
    });
  });
});

async function seedTask(opts: { title: string }): Promise<number> {
  return await withStore(loadSettings(), (store) => {
    store.startSession({ id: 'agent-session', ide: 'codex', cwd: repoRoot });
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'agent/codex/auto-handoff',
      title: opts.title,
      session_id: 'agent-session',
    });
    thread.join('agent-session', 'codex');
    return thread.task_id;
  });
}

async function runWorkingNote(args: string[]): Promise<void> {
  await createProgram().parseAsync(['node', 'test', 'note', 'working', ...args], {
    from: 'node',
  });
}
