import { userInfo } from 'node:os';
import { loadSettings } from '@colony/config';
import type { MemoryStore } from '@colony/core';
import { inferIdeFromSessionId } from '@colony/core';
import type { LaneRunState } from '@colony/storage';
import { type Command, InvalidArgumentError } from 'commander';
import kleur from 'kleur';
import { withStore } from '../util/store.js';

interface LaneActorOpts {
  requester?: string;
  json?: boolean;
}

interface LaneStateOpts extends LaneActorOpts {
  reason?: string;
}

interface LaneTakeoverOpts extends LaneActorOpts {
  file: string;
  reason: string;
}

export function registerLaneCommand(program: Command): void {
  const group = program.command('lane').description('Pause, resume, and take over contended lanes');

  group
    .command('pause <session-id>')
    .description('Mark a lane paused so other sessions see it in attention_inbox')
    .option('--reason <reason>', 'why the lane is paused')
    .option('--requester <session-id>', 'session recording the pause')
    .option('--json', 'emit JSON')
    .action(async (sessionId: string, opts: LaneStateOpts) => {
      await setLaneRunState(sessionId, 'paused', opts);
    });

  group
    .command('resume <session-id>')
    .description('Mark a paused lane active again')
    .option('--reason <reason>', 'why the lane is resumed')
    .option('--requester <session-id>', 'session recording the resume')
    .option('--json', 'emit JSON')
    .action(async (sessionId: string, opts: LaneStateOpts) => {
      await setLaneRunState(sessionId, 'active', opts);
    });

  group
    .command('takeover <session-id>')
    .description('Weaken a held claim and assign one file to the requester with audit history')
    .requiredOption('--file <path>', 'claimed file path to take over')
    .requiredOption('--reason <reason>', 'audit reason for the takeover')
    .option('--requester <session-id>', 'session receiving the file claim')
    .option('--json', 'emit JSON')
    .action(async (sessionId: string, opts: LaneTakeoverOpts) => {
      if (!opts.file.trim()) throw new InvalidArgumentError('--file is required');
      if (!opts.reason.trim()) throw new InvalidArgumentError('--reason is required');
      const settings = loadSettings();
      await withStore(settings, (store) => {
        const requester = resolveRequesterSession(opts);
        ensureCliSession(store, requester);
        const result = store.storage.takeOverLaneClaim({
          target_session_id: sessionId,
          requester_session_id: requester,
          requester_agent: inferAgent(requester),
          file_path: opts.file,
          reason: opts.reason,
        });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          return;
        }
        process.stdout.write(
          `${kleur.green('takeover recorded')}: ${result.file_path} from ${result.previous_session_id} -> ${result.assigned_session_id} (task #${result.task_id}, audit #${result.takeover_observation_id})\n`,
        );
      });
    });
}

async function setLaneRunState(
  sessionId: string,
  state: LaneRunState,
  opts: LaneStateOpts,
): Promise<void> {
  const settings = loadSettings();
  await withStore(settings, (store) => {
    const requester = resolveRequesterSession(opts);
    ensureCliSession(store, requester);
    const row = store.storage.setLaneState({
      session_id: sessionId,
      state,
      updated_by_session_id: requester,
      reason: opts.reason ?? null,
    });
    const taskId = store.storage.findActiveTaskForSession(sessionId);
    store.addObservation({
      session_id: requester,
      kind: state === 'paused' ? 'lane-pause' : 'lane-resume',
      content: `${state === 'paused' ? 'paused' : 'resumed'} lane ${sessionId}${opts.reason ? `: ${opts.reason}` : ''}`,
      task_id: taskId ?? null,
      metadata: {
        kind: state === 'paused' ? 'lane-pause' : 'lane-resume',
        target_session_id: sessionId,
        state,
        reason: opts.reason ?? null,
      },
    });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(row, null, 2)}\n`);
      return;
    }
    const label = state === 'paused' ? 'paused' : 'resumed';
    process.stdout.write(`${kleur.green(label)} lane ${sessionId} by ${requester}\n`);
  });
}

function resolveRequesterSession(opts: LaneActorOpts): string {
  const explicit = opts.requester?.trim();
  if (explicit) return explicit;
  const env =
    process.env.CODEX_SESSION_ID?.trim() ||
    process.env.CLAUDECODE_SESSION_ID?.trim() ||
    process.env.CLAUDE_SESSION_ID?.trim();
  if (env) return env;
  return `human:${safeUserName()}`;
}

function safeUserName(): string {
  try {
    return userInfo().username || 'unknown';
  } catch {
    return 'unknown';
  }
}

function ensureCliSession(store: MemoryStore, sessionId: string): void {
  const agent = inferAgent(sessionId);
  store.startSession({
    id: sessionId,
    ide: agent === 'claude' ? 'claude-code' : agent,
    cwd: process.cwd(),
    metadata: { source: 'colony lane cli', agent },
  });
}

function inferAgent(sessionId: string): string {
  const inferred = inferIdeFromSessionId(sessionId);
  if (inferred === 'claude-code') return 'claude';
  if (inferred && inferred !== 'unknown') return inferred;
  if (sessionId.startsWith('human:')) return 'human';
  return 'cli';
}
