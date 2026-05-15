import { loadSettings } from '@colony/config';
import { TaskThread } from '@colony/core';
import type { Storage, TaskRow } from '@colony/storage';
import type { Command } from 'commander';
import kleur from 'kleur';
import { withStore } from '../util/store.js';

type ProposalStatus = 'proposed' | 'approved' | 'archived';

interface ScoutCommandOptions {
  json?: boolean;
}

interface ScoutRejectOptions extends ScoutCommandOptions {
  reason?: string;
}

interface SqlResult {
  changes?: number;
}

interface SqlStatement {
  all(...args: unknown[]): unknown[];
  run(...args: unknown[]): SqlResult;
}

interface SqlDb {
  prepare(sql: string): SqlStatement;
}

interface StorageWithDb {
  db: SqlDb;
}

interface ProposedTaskRow extends TaskRow {
  proposal_status: ProposalStatus;
}

export function registerScoutCommand(program: Command): void {
  const group = program.command('scout').description('Review scout task proposals');

  group
    .command('list')
    .description('List proposed scout work')
    .option('--json', 'Emit JSON')
    .action(async (opts: ScoutCommandOptions) => {
      const settings = loadSettings();
      await withStore(settings, (store) => {
        const rows = listScoutProposals(store.storage);
        if (opts.json === true) {
          process.stdout.write(`${JSON.stringify(rows.map(proposalPayload), null, 2)}\n`);
          return;
        }
        if (rows.length === 0) {
          process.stdout.write(`${kleur.gray('no proposed scout work')}\n`);
          return;
        }
        for (const row of rows) {
          process.stdout.write(
            `#${row.id} ${row.branch} by=${row.created_by} evidence=${evidenceCount(row)} age=${formatAge(Date.now() - row.created_at)}\n`,
          );
        }
      });
    });

  group
    .command('approve <task_id>')
    .description('Approve a proposed scout task for executors')
    .option('--json', 'Emit JSON')
    .action(async (taskId: string, opts: ScoutCommandOptions) => {
      const settings = loadSettings();
      const id = parseTaskId(taskId);
      await withStore(settings, (store) => {
        const approvedBy = process.env.USER?.trim() || 'operator';
        const approved = updateProposalStatus(store.storage, id, 'approved', approvedBy);
        if (!approved) throw new Error(`proposed task not found: ${id}`);
        const payload = { task_id: id, proposal_status: 'approved', approved_by: approvedBy };
        process.stdout.write(
          `${opts.json === true ? JSON.stringify(payload) : `${kleur.green('approved')} #${id} by=${approvedBy}`}\n`,
        );
      });
    });

  group
    .command('reject <task_id>')
    .description('Archive a proposed scout task with a reason')
    .requiredOption('--reason <text>', 'Why the proposal was rejected')
    .option('--json', 'Emit JSON')
    .action(async (taskId: string, opts: ScoutRejectOptions) => {
      const settings = loadSettings();
      const id = parseTaskId(taskId);
      const reason = opts.reason?.trim();
      if (!reason) throw new Error('--reason is required');
      await withStore(settings, (store) => {
        const rejected = updateProposalStatus(store.storage, id, 'archived', null);
        if (!rejected) throw new Error(`proposed task not found: ${id}`);
        new TaskThread(store, id).post({
          session_id: process.env.USER?.trim() || 'operator',
          kind: 'note',
          content: `scout proposal rejected: ${reason}`,
          metadata: { scout_reject_reason: reason },
        });
        const payload = { task_id: id, proposal_status: 'archived', reason };
        process.stdout.write(
          `${opts.json === true ? JSON.stringify(payload) : `${kleur.yellow('rejected')} #${id} reason=${reason}`}\n`,
        );
      });
    });
}

function listScoutProposals(storage: Storage): ProposedTaskRow[] {
  return dbFor(storage)
    .prepare("SELECT * FROM tasks WHERE proposal_status = 'proposed' ORDER BY created_at ASC")
    .all() as ProposedTaskRow[];
}

function updateProposalStatus(
  storage: Storage,
  taskId: number,
  status: Exclude<ProposalStatus, 'proposed'>,
  approvedBy: string | null,
): boolean {
  const result = dbFor(storage)
    .prepare(
      `UPDATE tasks
          SET proposal_status = ?,
              approved_by = ?,
              updated_at = ?
        WHERE id = ?
          AND proposal_status = 'proposed'`,
    )
    .run(status, approvedBy, Date.now(), taskId);
  return (result.changes ?? 0) > 0;
}

function dbFor(storage: Storage): SqlDb {
  return (storage as unknown as StorageWithDb).db;
}

function proposalPayload(row: ProposedTaskRow): Record<string, unknown> {
  return {
    id: row.id,
    branch: row.branch,
    title: row.title,
    by: row.created_by,
    evidence: evidenceCount(row),
    age_ms: Date.now() - row.created_at,
  };
}

function evidenceCount(row: TaskRow): number {
  if (!row.observation_evidence_ids) return 0;
  try {
    const parsed = JSON.parse(row.observation_evidence_ids) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function parseTaskId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error('task_id must be a positive integer');
  return id;
}
