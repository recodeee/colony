import { resolve } from 'node:path';
import { loadSettings } from '@colony/config';
import { type MemoryStore, TaskThread } from '@colony/core';
import type { Command } from 'commander';
import kleur from 'kleur';
import { withStore } from '../util/store.js';

/**
 * Reserved session identifier for human scratch notes. Using a fixed id
 * (rather than a per-invocation random one) means every note across the
 * whole day lives under the same session, which makes "all my notes"
 * filters and timeline queries trivial.
 */
const OBSERVER_SESSION_ID = 'observer';

interface ActiveTaskCandidate {
  task_id: number;
  title: string;
  repo_root: string;
  branch: string;
  status: string;
  updated_at: number;
  agent: string;
}

interface WorkingNoteOptions {
  sessionId: string;
  repoRoot: string;
  branch?: string;
  task?: string;
  blocker?: string;
  next?: string;
  evidence?: string;
  json?: boolean;
}

interface WorkingNoteOutput {
  note_text: string;
  task_id: number;
  observation_id: number;
  replaced_previous_working_note: boolean;
  previous_working_note_id: number | null;
  warnings: string[];
  next_recommended_action: string;
}

/**
 * Idempotently materialise the observer session so the FK from
 * observations.session_id holds. `startSession` is `INSERT OR IGNORE`, so
 * this is effectively free after the first call.
 */
function ensureObserverSession(store: MemoryStore): void {
  store.startSession({
    id: OBSERVER_SESSION_ID,
    ide: 'observer',
    cwd: process.cwd(),
  });
}

export function registerNoteCommand(program: Command): void {
  const note = program
    .command('note')
    .description('Record scratch notes and compact working handoff notes')
    // Variadic so `colony note codex stepped on claude` works without quoting.
    .argument('[text...]', 'scratch note text')
    .option('--task <id>', 'Attach this note to a specific task thread (shows up in task_timeline)')
    .action(async (words: string[] | undefined, opts: { task?: string }) => {
      const text = (words ?? []).join(' ').trim();
      if (!text) {
        process.stderr.write(`${kleur.red('empty note')}\n`);
        process.exitCode = 1;
        return;
      }

      const settings = loadSettings();
      await withStore(settings, (store) => {
        ensureObserverSession(store);
        const id = store.addObservation({
          session_id: OBSERVER_SESSION_ID,
          kind: 'observer-note',
          content: text,
          ...(opts.task ? { task_id: Number(opts.task) } : {}),
        });
        const when = new Date().toISOString().slice(11, 19);
        process.stdout.write(
          `${kleur.green('✓')} note #${id} at ${when}${opts.task ? ` on task #${opts.task}` : ''}\n`,
        );
      });
    });

  note
    .command('working')
    .description('Post a compact branch/task/blocker/next/evidence working handoff note')
    .requiredOption('--session-id <id>', 'Agent session id posting the note')
    .requiredOption('--repo-root <path>', 'Repository root used to infer the active task')
    .option('--branch <branch>', 'Branch to use and resolve against')
    .option('--task <text>', 'Task label for the compact note')
    .option('--blocker <text>', 'Current blocker; defaults to none')
    .option('--next <text>', 'Next concrete action')
    .option('--evidence <pointer>', 'Compact evidence pointer such as a path, command, PR, or spec')
    .option('--json', 'Emit machine-readable output')
    .action(async (opts: WorkingNoteOptions) => {
      const settings = loadSettings();
      await withStore(settings, (store) => {
        const result = postWorkingHandoffNote(store, opts);
        if ('error' in result) {
          if (opts.json) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          } else {
            process.stderr.write(`${kleur.red(result.error)}\n`);
            if (result.errors) {
              for (const error of result.errors) process.stderr.write(`- ${error}\n`);
            }
          }
          process.exitCode = 1;
          return;
        }

        if (opts.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          return;
        }

        process.stdout.write(`${kleur.green('✓')} working note #${result.observation_id}\n`);
        process.stdout.write(`${result.note_text}\n`);
        process.stdout.write(`task_id=${result.task_id}\n`);
        process.stdout.write(
          `replaced_previous_working_note=${String(result.replaced_previous_working_note)}\n`,
        );
        if (result.warnings.length > 0) {
          process.stdout.write(`warnings=${result.warnings.join('; ')}\n`);
        }
        process.stdout.write(`next_recommended_action=${result.next_recommended_action}\n`);
      });
    });
}

function postWorkingHandoffNote(
  store: MemoryStore,
  opts: WorkingNoteOptions,
):
  | WorkingNoteOutput
  | {
      code: string;
      error: string;
      errors?: string[];
      warnings?: string[];
      candidates?: ActiveTaskCandidate[];
    } {
  const candidates = activeTaskCandidates(store, opts);
  if (candidates.length !== 1) {
    return {
      code: candidates.length === 0 ? 'ACTIVE_TASK_NOT_FOUND' : 'AMBIGUOUS_ACTIVE_TASK',
      error:
        candidates.length === 0
          ? 'no active Colony task matched session/repo/branch'
          : 'multiple active Colony tasks matched session/repo/branch',
      candidates: candidates.slice(0, 10),
    };
  }

  const candidate = candidates[0];
  if (!candidate) throw new Error('working note task resolution lost its only candidate');
  const built = TaskThread.buildWorkingHandoffNote({
    branch: opts.branch ?? candidate.branch,
    task: opts.task ?? candidate.title,
    blocker: opts.blocker,
    next: opts.next,
    evidence: opts.evidence,
  });
  if (!built.ok) {
    return {
      code: 'INVALID_WORKING_HANDOFF_NOTE',
      error: 'working handoff note is missing required compact fields',
      errors: built.errors,
      warnings: built.warnings,
    };
  }

  const previous = latestLiveWorkingHandoffNote(store, candidate.task_id);
  const thread = new TaskThread(store, candidate.task_id);
  const observation_id = store.storage.transaction(() => {
    const id = thread.post({
      session_id: opts.sessionId,
      kind: 'note',
      content: built.note_text,
      metadata: {
        working_note: true,
        auto_handoff_note: true,
        live: true,
        resolved_by: 'colony_note_working',
        fields: built.fields,
        warnings: built.warnings,
        previous_working_note_id: previous?.id ?? null,
        ...(opts.repoRoot !== undefined ? { requested_repo_root: opts.repoRoot } : {}),
        ...(opts.branch !== undefined ? { requested_branch: opts.branch } : {}),
      },
    });
    if (previous) {
      store.storage.updateObservationMetadata(
        previous.id,
        JSON.stringify(TaskThread.supersedeWorkingHandoffMetadata(previous.metadata, id)),
      );
    }
    return id;
  });

  return {
    note_text: built.note_text,
    task_id: candidate.task_id,
    observation_id,
    replaced_previous_working_note: previous !== undefined,
    previous_working_note_id: previous?.id ?? null,
    warnings: built.warnings,
    next_recommended_action: built.next_recommended_action,
  };
}

function activeTaskCandidates(store: MemoryStore, opts: WorkingNoteOptions): ActiveTaskCandidate[] {
  const repoRoot = resolvePath(opts.repoRoot);
  const candidates: ActiveTaskCandidate[] = [];
  for (const task of store.storage.listTasks(2000)) {
    if (resolvePath(task.repo_root) !== repoRoot) continue;
    if (opts.branch !== undefined && task.branch !== opts.branch) continue;
    const participant = store.storage
      .listParticipants(task.id)
      .find((row) => row.session_id === opts.sessionId && row.left_at === null);
    if (!participant) continue;
    candidates.push({
      task_id: task.id,
      title: task.title,
      repo_root: task.repo_root,
      branch: task.branch,
      status: task.status,
      updated_at: task.updated_at,
      agent: participant.agent,
    });
  }
  return candidates.sort((a, b) => b.updated_at - a.updated_at);
}

function latestLiveWorkingHandoffNote(store: MemoryStore, taskId: number) {
  return store.storage
    .taskObservationsByKind(taskId, 'note', 100)
    .find((row) => TaskThread.isLiveWorkingHandoffMetadata(row.metadata));
}

function resolvePath(value: string): string {
  return resolve(value);
}
