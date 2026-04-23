import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { COLUMN_MIGRATIONS, POST_MIGRATION_SQL, SCHEMA_SQL } from './schema.js';
import type {
  NewObservation,
  NewSummary,
  NewTask,
  ObservationRow,
  SearchHit,
  SessionRow,
  SummaryRow,
  TaskClaimRow,
  TaskParticipantRow,
  TaskRow,
} from './types.js';

export interface StorageOptions {
  readonly?: boolean;
}

export class Storage {
  private db: Database.Database;

  constructor(dbPath: string, opts: StorageOptions = {}) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, opts.readonly ? { readonly: true } : {});
    this.db.exec(SCHEMA_SQL);
    if (!opts.readonly) {
      this.applyColumnMigrations();
      this.db.exec(POST_MIGRATION_SQL);
    }
  }

  /**
   * SQLite's `CREATE TABLE IF NOT EXISTS` is idempotent; `ALTER TABLE ADD
   * COLUMN` is not — it throws if the column already exists. We read
   * `PRAGMA table_info` and apply each pending add only once.
   */
  private applyColumnMigrations(): void {
    for (const { table, column, sql } of COLUMN_MIGRATIONS) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (cols.some((c) => c.name === column)) continue;
      this.db.exec(sql);
    }
  }

  close(): void {
    this.db.close();
  }

  // --- sessions ---

  createSession(s: Omit<SessionRow, 'ended_at'>): void {
    // INSERT OR IGNORE: SessionStart re-fires on resume/clear/compact with the
    // same session_id, and we want the original row (and ended_at=null) preserved.
    this.db
      .prepare(
        'INSERT OR IGNORE INTO sessions(id, ide, cwd, started_at, metadata) VALUES (?, ?, ?, ?, ?)',
      )
      .run(s.id, s.ide, s.cwd, s.started_at, s.metadata);
  }

  endSession(id: string, ts = Date.now()): void {
    this.db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(ts, id);
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  listSessions(limit = 50): SessionRow[] {
    return this.db
      .prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?')
      .all(limit) as SessionRow[];
  }

  // --- observations ---

  insertObservation(o: NewObservation): number {
    const ts = o.ts ?? Date.now();
    const stmt = this.db.prepare(
      'INSERT INTO observations(session_id, kind, content, compressed, intensity, ts, metadata, task_id, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const info = stmt.run(
      o.session_id,
      o.kind,
      o.content,
      o.compressed ? 1 : 0,
      o.intensity,
      ts,
      o.metadata ? JSON.stringify(o.metadata) : null,
      o.task_id ?? null,
      o.reply_to ?? null,
    );
    return Number(info.lastInsertRowid);
  }

  getObservation(id: number): ObservationRow | undefined {
    return this.db.prepare('SELECT * FROM observations WHERE id = ?').get(id) as
      | ObservationRow
      | undefined;
  }

  updateObservationMetadata(id: number, metadata: string): void {
    this.db.prepare('UPDATE observations SET metadata = ? WHERE id = ?').run(metadata, id);
  }

  getObservations(ids: number[]): ObservationRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db
      .prepare(`SELECT * FROM observations WHERE id IN (${placeholders})`)
      .all(...ids) as ObservationRow[];
  }

  timeline(sessionId: string, aroundId?: number, limit = 50): ObservationRow[] {
    if (aroundId === undefined) {
      return this.db
        .prepare('SELECT * FROM observations WHERE session_id = ? ORDER BY ts DESC LIMIT ?')
        .all(sessionId, limit) as ObservationRow[];
    }
    // Return up to `limit` rows centred on aroundId — two independent,
    // bounded queries merged in JS so neither side can starve the other.
    // A single UNION with a trailing LIMIT would let the "after" half
    // swallow the whole window.
    const half = Math.max(1, Math.floor(limit / 2));
    const before = this.db
      .prepare(
        'SELECT * FROM observations WHERE session_id = ? AND id <= ? ORDER BY id DESC LIMIT ?',
      )
      .all(sessionId, aroundId, half) as ObservationRow[];
    const after = this.db
      .prepare('SELECT * FROM observations WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
      .all(sessionId, aroundId, limit - before.length) as ObservationRow[];
    const seen = new Set<number>();
    const merged: ObservationRow[] = [];
    for (const row of [...before.slice().reverse(), ...after]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
    }
    return merged;
  }

  // --- summaries ---

  insertSummary(s: NewSummary): number {
    const ts = s.ts ?? Date.now();
    const info = this.db
      .prepare(
        'INSERT INTO summaries(session_id, scope, content, compressed, intensity, ts) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(s.session_id, s.scope, s.content, s.compressed ? 1 : 0, s.intensity, ts);
    return Number(info.lastInsertRowid);
  }

  listSummaries(sessionId: string): SummaryRow[] {
    return this.db
      .prepare('SELECT * FROM summaries WHERE session_id = ? ORDER BY ts DESC')
      .all(sessionId) as SummaryRow[];
  }

  // --- search (BM25 via FTS5) ---

  searchFts(query: string, limit = 10): SearchHit[] {
    if (!query.trim()) return [];
    const rows = this.db
      .prepare(
        `SELECT o.id, o.session_id, o.ts,
                snippet(observations_fts, 0, '[', ']', '…', 16) AS snippet,
                bm25(observations_fts) AS score
         FROM observations_fts
         JOIN observations o ON o.id = observations_fts.rowid
         WHERE observations_fts MATCH ?
         ORDER BY score ASC
         LIMIT ?`,
      )
      .all(sanitizeMatch(query), limit) as Array<{
      id: number;
      session_id: string;
      ts: number;
      snippet: string;
      score: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      snippet: r.snippet,
      // FTS5 bm25 is "lower is better". Flip sign so higher = better downstream.
      score: -r.score,
      ts: r.ts,
    }));
  }

  // --- embeddings ---

  putEmbedding(observationId: number, model: string, vec: Float32Array): void {
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    this.db
      .prepare(
        'INSERT OR REPLACE INTO embeddings(observation_id, model, dim, vec) VALUES (?, ?, ?, ?)',
      )
      .run(observationId, model, vec.length, buf);
  }

  getEmbedding(
    observationId: number,
  ): { model: string; dim: number; vec: Float32Array } | undefined {
    const row = this.db
      .prepare('SELECT model, dim, vec FROM embeddings WHERE observation_id = ?')
      .get(observationId) as { model: string; dim: number; vec: Buffer } | undefined;
    if (!row) return undefined;
    const vec = new Float32Array(row.vec.buffer, row.vec.byteOffset, row.dim);
    return { model: row.model, dim: row.dim, vec };
  }

  allEmbeddings(filter?: { model: string; dim: number }): Array<{
    observation_id: number;
    vec: Float32Array;
  }> {
    const rows = filter
      ? (this.db
          .prepare('SELECT observation_id, dim, vec FROM embeddings WHERE model = ? AND dim = ?')
          .all(filter.model, filter.dim) as Array<{
          observation_id: number;
          dim: number;
          vec: Buffer;
        }>)
      : (this.db.prepare('SELECT observation_id, dim, vec FROM embeddings').all() as Array<{
          observation_id: number;
          dim: number;
          vec: Buffer;
        }>);
    return rows.map((r) => ({
      observation_id: r.observation_id,
      // Copy into a fresh buffer — the underlying Buffer from better-sqlite3
      // is freed after the statement is iterated, so aliasing it into a
      // Float32Array is not safe once the row goes out of scope.
      vec: new Float32Array(
        new Uint8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength).slice().buffer,
      ),
    }));
  }

  observationsMissingEmbeddings(limit = 100, model?: string): ObservationRow[] {
    if (model) {
      return this.db
        .prepare(
          `SELECT o.* FROM observations o
           LEFT JOIN embeddings e ON e.observation_id = o.id AND e.model = ?
           WHERE e.observation_id IS NULL
           ORDER BY o.id DESC
           LIMIT ?`,
        )
        .all(model, limit) as ObservationRow[];
    }
    return this.db
      .prepare(
        `SELECT o.* FROM observations o
         LEFT JOIN embeddings e ON e.observation_id = o.id
         WHERE e.observation_id IS NULL
         ORDER BY o.id DESC
         LIMIT ?`,
      )
      .all(limit) as ObservationRow[];
  }

  /**
   * Remove embeddings whose model does not match the currently configured one.
   * Returns the number of rows deleted. Used on worker startup when the user
   * has switched embedding models — mixed-model cosine returns garbage.
   */
  dropEmbeddingsWhereModelNot(model: string): number {
    const info = this.db.prepare('DELETE FROM embeddings WHERE model != ?').run(model);
    return Number(info.changes);
  }

  countObservations(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number };
    return row.n;
  }

  countEmbeddings(filter?: { model: string; dim: number }): number {
    if (filter) {
      const row = this.db
        .prepare('SELECT COUNT(*) AS n FROM embeddings WHERE model = ? AND dim = ?')
        .get(filter.model, filter.dim) as { n: number };
      return row.n;
    }
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM embeddings').get() as { n: number };
    return row.n;
  }

  lastObservationAt(): number | null {
    const row = this.db.prepare('SELECT MAX(ts) AS t FROM observations').get() as {
      t: number | null;
    };
    return row.t ?? null;
  }

  // --- tasks ---

  /**
   * Find-or-create the task for a (repo_root, branch) pair. The UNIQUE
   * constraint on (repo_root, branch) makes this the auto-join key: two
   * sessions that enter a worktree with the same branch land on the same
   * task_id, which is how the hivemind's passive "synchronised notebook"
   * view becomes an active collaboration substrate.
   */
  findOrCreateTask(p: NewTask): TaskRow {
    const now = Date.now();
    const existing = this.db
      .prepare('SELECT * FROM tasks WHERE repo_root = ? AND branch = ?')
      .get(p.repo_root, p.branch) as TaskRow | undefined;
    if (existing) return existing;
    const info = this.db
      .prepare(
        'INSERT INTO tasks(title, repo_root, branch, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(p.title, p.repo_root, p.branch, 'open', p.created_by, now, now);
    return {
      id: Number(info.lastInsertRowid),
      title: p.title,
      repo_root: p.repo_root,
      branch: p.branch,
      status: 'open',
      created_by: p.created_by,
      created_at: now,
      updated_at: now,
    };
  }

  getTask(id: number): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  }

  findTaskByBranch(repo_root: string, branch: string): TaskRow | undefined {
    return this.db
      .prepare('SELECT * FROM tasks WHERE repo_root = ? AND branch = ?')
      .get(repo_root, branch) as TaskRow | undefined;
  }

  listTasks(limit = 50): TaskRow[] {
    return this.db
      .prepare('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as TaskRow[];
  }

  touchTask(id: number, ts = Date.now()): void {
    this.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(ts, id);
  }

  addTaskParticipant(p: { task_id: number; session_id: string; agent: string }): void {
    // INSERT OR IGNORE: a session re-entering the same task (resume/clear)
    // must not double-join and must not clobber the original joined_at.
    this.db
      .prepare(
        'INSERT OR IGNORE INTO task_participants(task_id, session_id, agent, joined_at) VALUES (?, ?, ?, ?)',
      )
      .run(p.task_id, p.session_id, p.agent, Date.now());
  }

  listParticipants(task_id: number): TaskParticipantRow[] {
    return this.db
      .prepare('SELECT * FROM task_participants WHERE task_id = ? ORDER BY joined_at ASC')
      .all(task_id) as TaskParticipantRow[];
  }

  getParticipantAgent(task_id: number, session_id: string): string | undefined {
    const row = this.db
      .prepare('SELECT agent FROM task_participants WHERE task_id = ? AND session_id = ?')
      .get(task_id, session_id) as { agent: string } | undefined;
    return row?.agent;
  }

  findActiveTaskForSession(session_id: string): number | undefined {
    // A session may in principle participate in multiple tasks; we return
    // the most recently-active one. In practice the (repo_root, branch)
    // uniqueness means one live task per session.
    const row = this.db
      .prepare(
        `SELECT t.id FROM tasks t
         JOIN task_participants p ON p.task_id = t.id
         WHERE p.session_id = ? AND p.left_at IS NULL
         ORDER BY t.updated_at DESC LIMIT 1`,
      )
      .get(session_id) as { id: number } | undefined;
    return row?.id;
  }

  claimFile(c: { task_id: number; file_path: string; session_id: string }): void {
    // REPLACE semantics: the latest claimer wins. Handoffs atomically swap
    // ownership, so the invariant "at most one owner per (task, file)" is
    // preserved by the transaction, not by the primary key alone.
    this.db
      .prepare(
        'INSERT OR REPLACE INTO task_claims(task_id, file_path, session_id, claimed_at) VALUES (?, ?, ?, ?)',
      )
      .run(c.task_id, c.file_path, c.session_id, Date.now());
  }

  releaseClaim(c: { task_id: number; file_path: string; session_id: string }): void {
    // Only the current owner can release. Prevents a stale handoff from
    // silently dropping claims another agent already took over.
    this.db
      .prepare('DELETE FROM task_claims WHERE task_id = ? AND file_path = ? AND session_id = ?')
      .run(c.task_id, c.file_path, c.session_id);
  }

  getClaim(task_id: number, file_path: string): TaskClaimRow | undefined {
    return this.db
      .prepare('SELECT * FROM task_claims WHERE task_id = ? AND file_path = ?')
      .get(task_id, file_path) as TaskClaimRow | undefined;
  }

  listClaims(task_id: number): TaskClaimRow[] {
    return this.db
      .prepare('SELECT * FROM task_claims WHERE task_id = ? ORDER BY claimed_at ASC')
      .all(task_id) as TaskClaimRow[];
  }

  taskObservationsSince(task_id: number, since_ts: number, limit = 50): ObservationRow[] {
    return this.db
      .prepare('SELECT * FROM observations WHERE task_id = ? AND ts > ? ORDER BY ts ASC LIMIT ?')
      .all(task_id, since_ts, limit) as ObservationRow[];
  }

  taskObservationsByKind(task_id: number, kind: string, limit = 100): ObservationRow[] {
    return this.db
      .prepare('SELECT * FROM observations WHERE task_id = ? AND kind = ? ORDER BY ts DESC LIMIT ?')
      .all(task_id, kind, limit) as ObservationRow[];
  }

  taskTimeline(task_id: number, limit = 50): ObservationRow[] {
    return this.db
      .prepare('SELECT * FROM observations WHERE task_id = ? ORDER BY ts DESC LIMIT ?')
      .all(task_id, limit) as ObservationRow[];
  }

  /**
   * The last observation timestamp for a session, optionally filtered by
   * kind. Used by the UserPromptSubmit hook to scope "new activity since my
   * last turn" without a separate cursor table.
   */
  lastObservationTsForSession(session_id: string, kind?: string): number {
    const row = kind
      ? (this.db
          .prepare('SELECT MAX(ts) AS t FROM observations WHERE session_id = ? AND kind = ?')
          .get(session_id, kind) as { t: number | null })
      : (this.db
          .prepare('SELECT MAX(ts) AS t FROM observations WHERE session_id = ?')
          .get(session_id) as { t: number | null });
    return row.t ?? 0;
  }

  /** Run a function inside a SQLite transaction. All-or-nothing. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

function sanitizeMatch(q: string): string {
  // Escape double quotes and wrap each bare term to avoid FTS5 syntax errors.
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}
