import type { MemoryStore } from '@colony/core';

export const PROPOSAL_ARCHIVE_INTERVAL_MS = 6 * 60 * 60_000;
export const STALE_PROPOSAL_AGE_MS = 7 * 24 * 60 * 60_000;
export const PROPOSAL_ARCHIVE_SESSION_ID = 'colony-worker:proposals-archive';

export interface ProposalArchiveJobResult {
  archived_count: number;
  archived_task_ids: number[];
}

export interface ProposalArchiveJobOptions {
  now?: () => number;
  staleAfterMs?: number;
}

export interface ProposalArchiveLoopHandle {
  stop: () => Promise<void>;
  lastResult: () => ProposalArchiveJobResult | null;
  runNow: () => Promise<ProposalArchiveJobResult>;
}

export interface ProposalArchiveLoopOptions extends ProposalArchiveJobOptions {
  store: MemoryStore;
  intervalMs?: number;
  log?: (line: string) => void;
}

interface SqlRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

interface SqlStatement {
  all(...args: unknown[]): Array<Record<string, unknown>>;
  get(...args: unknown[]): Record<string, unknown> | undefined;
  run(...args: unknown[]): SqlRunResult;
}

interface SqlDatabase {
  prepare(sql: string): SqlStatement;
}

interface StorageWithDb {
  db: SqlDatabase;
}

interface ProposedTaskRow {
  id: number;
  title: string;
  created_by: string;
}

export function runProposalArchiveJob(
  store: MemoryStore,
  opts: ProposalArchiveJobOptions = {},
): ProposalArchiveJobResult {
  const now = opts.now?.() ?? Date.now();
  const cutoff = now - (opts.staleAfterMs ?? STALE_PROPOSAL_AGE_MS);
  const db = rawDb(store);
  return store.storage.transaction(
    () => {
      store.storage.createSession({
        id: PROPOSAL_ARCHIVE_SESSION_ID,
        ide: 'worker',
        cwd: null,
        started_at: now,
        metadata: null,
      });

      const stale = db
        .prepare(
          `SELECT id, title, created_by
             FROM tasks
            WHERE proposal_status = 'proposed'
              AND created_at < ?
            ORDER BY created_at ASC, id ASC`,
        )
        .all(cutoff)
        .map(normalizeTaskRow);
      const archivedTaskIds: number[] = [];

      for (const task of stale) {
        const result = db
          .prepare(
            `UPDATE tasks
                SET proposal_status = 'archived',
                    updated_at = ?
              WHERE id = ?
                AND proposal_status = 'proposed'`,
          )
          .run(now, task.id);
        if (result.changes === 0) continue;

        db.prepare(
          `UPDATE agent_profiles
              SET open_proposal_count = CASE
                    WHEN open_proposal_count > 0 THEN open_proposal_count - 1
                    ELSE 0
                  END,
                  updated_at = ?
            WHERE agent = ?`,
        ).run(now, task.created_by);
        store.storage.insertObservation({
          session_id: PROPOSAL_ARCHIVE_SESSION_ID,
          kind: 'proposal-auto-archived',
          content: `Auto-archived stale proposal task ${task.id}: ${task.title}`,
          compressed: false,
          intensity: null,
          ts: now,
          task_id: task.id,
          metadata: {
            proposer: task.created_by,
            stale_after_ms: opts.staleAfterMs ?? STALE_PROPOSAL_AGE_MS,
          },
        });
        archivedTaskIds.push(task.id);
      }

      return {
        archived_count: archivedTaskIds.length,
        archived_task_ids: archivedTaskIds,
      };
    },
    { immediate: true },
  );
}

export function startProposalArchiveJobLoop(
  opts: ProposalArchiveLoopOptions,
): ProposalArchiveLoopHandle {
  const { store } = opts;
  const intervalMs = opts.intervalMs ?? PROPOSAL_ARCHIVE_INTERVAL_MS;
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let stopped = false;
  let inFlight: Promise<ProposalArchiveJobResult | undefined> | null = null;
  let latest: ProposalArchiveJobResult | null = null;

  const runOnce = (): ProposalArchiveJobResult => {
    const result = runProposalArchiveJob(store, opts);
    latest = result;
    logRun(log, result);
    return result;
  };

  const tick = async (): Promise<ProposalArchiveJobResult | undefined> => {
    if (stopped) return;
    try {
      return runOnce();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(JSON.stringify({ component: 'colony-worker', job: 'proposals-archive', error: message }));
    }
  };

  let timer: NodeJS.Timeout | null = null;
  if (intervalMs !== 0) {
    const firstRunDelay = Math.min(5_000, intervalMs);
    timer = setTimeout(function loop() {
      if (stopped) return;
      inFlight = tick();
      void inFlight.finally(() => {
        if (stopped) return;
        timer = setTimeout(loop, intervalMs);
      });
    }, firstRunDelay);
  }

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (inFlight) await inFlight;
    },
    lastResult: () => latest,
    runNow: async () => runOnce(),
  };
}

function rawDb(store: MemoryStore): SqlDatabase {
  return (store.storage as unknown as StorageWithDb).db;
}

function normalizeTaskRow(row: Record<string, unknown>): ProposedTaskRow {
  return {
    id: typeof row.id === 'number' ? row.id : 0,
    title: typeof row.title === 'string' ? row.title : '',
    created_by: typeof row.created_by === 'string' ? row.created_by : '',
  };
}

function logRun(log: (line: string) => void, result: ProposalArchiveJobResult): void {
  log(
    JSON.stringify({
      component: 'colony-worker',
      job: 'proposals-archive',
      archived_count: result.archived_count,
      archived_task_ids: result.archived_task_ids,
    }),
  );
}
