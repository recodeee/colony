import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { COLUMN_MIGRATIONS, POST_MIGRATION_SQL, SCHEMA_SQL } from './schema.js';
import {
  COORDINATION_COMMIT_TOOLS,
  COORDINATION_READ_TOOLS,
  FILE_EDIT_TOOLS,
} from './tool-classes.js';
import type {
  AgentProfileRow,
  ExampleRow,
  LinkedTask,
  NewAgentProfile,
  NewExample,
  NewObservation,
  NewPheromone,
  NewProposal,
  NewReinforcement,
  NewSummary,
  NewTask,
  NewTaskEmbedding,
  NewTaskLink,
  ObservationRow,
  PheromoneRow,
  ProposalRow,
  ProposalStatus,
  ReinforcementRow,
  SearchHit,
  SessionRow,
  SummaryRow,
  TaskClaimRow,
  TaskEmbeddingRow,
  TaskLinkRow,
  TaskParticipantRow,
  TaskRow,
} from './types.js';

export interface StorageOptions {
  readonly?: boolean;
}

export interface FindStrandedSessionsOptions {
  stranded_after_ms?: number;
}

export interface StrandedSessionRow {
  session_id: string;
  ide: string;
  cwd: string | null;
  last_observation_ts: number;
  held_claims_json: string;
  last_tool_error: string | null;
}

export interface CoordinationActivity {
  commits: number;
  reads: number;
  commits_by_session: Map<string, number>;
  reads_by_session: Map<string, number>;
}

export interface KindCount {
  kind: string;
  count: number;
}

export interface ClaimCoverageStats {
  edit_count: number;
  explicit_claim_count: number;
  auto_claim_count: number;
  explicit_claim_kinds: KindCount[];
  auto_claim_kinds: KindCount[];
}

export interface BashCoordinationVolume {
  git_op_count: number;
  file_op_count: number;
  top_files_by_file_op: Array<{ file_path: string; count: number }>;
}

export interface FileHeatRow {
  task_id: number;
  file_path: string;
  heat: number;
  last_activity_ts: number;
  event_count: number;
}

export interface FileHeatOptions {
  task_ids?: number[];
  now?: number;
  half_life_minutes: number;
  limit?: number;
  min_heat?: number;
}

export interface EditsWithoutClaimsRow {
  session_id: string;
  file_path: string;
  edit_ts: number;
  has_sibling_claim_within_window: boolean;
}

export interface SessionsEndedWithoutHandoffRow {
  session_id: string;
  last_observation_ts: number;
  had_active_claims: boolean;
  had_pending_handoff: boolean;
}

export interface ToolCallRow {
  id: number;
  session_id: string;
  tool: string;
  ts: number;
}

export interface RecentObservationRow {
  id: number;
  session_id: string;
  kind: string;
  content: string;
  ts: number;
}

export interface ClaimBeforeEditStats {
  edit_tool_calls: number;
  edits_with_file_path: number;
  edits_claimed_before: number;
  auto_claimed_before_edit?: number;
  /** Count of PreToolUse claim-before-edit rows that had to be recorded under
   *  a fallback diagnostics session because the hook session row was missing. */
  session_binding_missing?: number;
  /** Count of `claim-before-edit` telemetry observations in the window — any
   *  outcome (success, conflict, failure). Authoritative signal that the
   *  PreToolUse hook is firing at all in the active editor sessions. */
  pre_tool_use_signals?: number;
}

export interface ClaimCoverageSnapshot {
  since: number;
  until: number;
  edit_write_count: number;
  auto_claim_count: number;
  explicit_claim_count: number;
  claim_conflict_count: number;
  bash_git_op_count: number;
  bash_file_op_count: number;
  bash_git_file_op_count: number;
}

const DEFAULT_STRANDED_AFTER_MS = 10 * 60_000;
const DEFAULT_CLAIM_WINDOW_MS = 5 * 60_000;
const DEFAULT_IDLE_WINDOW_MS = 30 * 60_000;
const DEFAULT_FILE_HEAT_LIMIT = 10;
const DEFAULT_FILE_HEAT_MIN_HEAT = 0.05;
const FILE_HEAT_LOOKBACK_HALF_LIVES = 8;
const COORDINATION_COMMIT_TOOLS_JSON = JSON.stringify(Array.from(COORDINATION_COMMIT_TOOLS));
const COORDINATION_READ_TOOLS_JSON = JSON.stringify(Array.from(COORDINATION_READ_TOOLS));
const FILE_EDIT_TOOLS_JSON = JSON.stringify(Array.from(FILE_EDIT_TOOLS));
const EXPLICIT_CLAIM_KINDS = ['claim'];
const AUTO_CLAIM_KINDS = ['auto-claim'];
type JsonRecord = Record<string, unknown>;

export class Storage {
  private db: Database.Database;
  private getTaskEmbeddingStmt!: Database.Statement;
  private upsertTaskEmbeddingStmt: Database.Statement | undefined;
  private countTaskObservationsStmt!: Database.Statement;
  private findStrandedSessionsStmt!: Database.Statement;
  private recentToolErrorsStmt!: Database.Statement;
  private coordinationActivityStmt!: Database.Statement;
  private editsWithoutClaimsStmt!: Database.Statement;
  private sessionsEndedWithoutHandoffStmt!: Database.Statement;

  constructor(dbPath: string, opts: StorageOptions = {}) {
    if (!opts.readonly) mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, opts.readonly ? { readonly: true } : {});
    if (opts.readonly) {
      this.db.pragma('foreign_keys = ON');
    } else {
      this.db.exec(SCHEMA_SQL);
      this.applyTableMigrations();
      this.applyColumnMigrations();
      this.db.exec(POST_MIGRATION_SQL);
    }
    this.prepareTaskEmbeddingStatements(opts.readonly ?? false);
  }

  private applyTableMigrations(): void {
    const cols = this.db.prepare('PRAGMA table_info(task_embeddings)').all() as Array<{
      name: string;
    }>;
    const hasVec = cols.some((c) => c.name === 'vec');
    const hasEmbedding = cols.some((c) => c.name === 'embedding');
    if (hasVec && !hasEmbedding) {
      this.db.exec('ALTER TABLE task_embeddings RENAME COLUMN vec TO embedding');
    }
    this.migrateProposalReinforcementAuditRows();
  }

  private migrateProposalReinforcementAuditRows(): void {
    if (!this.tableExists('proposal_reinforcements')) return;
    const cols = this.db.prepare('PRAGMA table_info(proposal_reinforcements)').all() as Array<{
      name: string;
    }>;
    if (cols.some((c) => c.name === 'id')) return;

    this.db.pragma('foreign_keys = OFF');
    try {
      this.db.exec(`
        BEGIN;
        DROP INDEX IF EXISTS idx_reinforcements_proposal;
        ALTER TABLE proposal_reinforcements RENAME TO proposal_reinforcements_old;
        CREATE TABLE proposal_reinforcements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          weight REAL NOT NULL,
          reinforced_at INTEGER NOT NULL
        );
        INSERT INTO proposal_reinforcements(proposal_id, session_id, kind, weight, reinforced_at)
          SELECT proposal_id, session_id, kind, weight, reinforced_at
          FROM proposal_reinforcements_old
          ORDER BY proposal_id, reinforced_at, session_id;
        DROP TABLE proposal_reinforcements_old;
        CREATE INDEX IF NOT EXISTS idx_reinforcements_proposal
          ON proposal_reinforcements(proposal_id);
        COMMIT;
      `);
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Keep the original migration error visible.
      }
      throw err;
    } finally {
      this.db.pragma('foreign_keys = ON');
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

  private prepareTaskEmbeddingStatements(readonly: boolean): void {
    const hasTaskEmbeddings = this.tableExists('task_embeddings');
    this.getTaskEmbeddingStmt = hasTaskEmbeddings
      ? this.db.prepare(
          'SELECT task_id, model, dim, embedding, observation_count, computed_at FROM task_embeddings WHERE task_id = ?',
        )
      : this.db.prepare(
          'SELECT NULL AS task_id, NULL AS model, NULL AS dim, NULL AS embedding, NULL AS observation_count, NULL AS computed_at WHERE 0',
        );
    this.countTaskObservationsStmt = this.db.prepare(
      'SELECT COUNT(*) AS n FROM observations WHERE task_id = ?',
    );
    this.findStrandedSessionsStmt = this.db.prepare(
      `SELECT s.id AS session_id,
              s.ide,
              s.cwd,
              COALESCE(MAX(o.ts), s.started_at) AS last_observation_ts,
              (SELECT json_group_array(json_object(
                  'task_id', tc.task_id,
                  'file_path', tc.file_path,
                  'claimed_at', tc.claimed_at
              )) FROM task_claims tc WHERE tc.session_id = s.id) AS held_claims_json,
              (SELECT json_extract(o2.metadata, '$.error') FROM observations o2
               WHERE o2.session_id = s.id AND o2.kind = 'tool_use'
               ORDER BY o2.ts DESC LIMIT 1) AS last_tool_error
       FROM sessions s
       LEFT JOIN observations o ON o.session_id = s.id
       WHERE s.ended_at IS NULL
       GROUP BY s.id
       HAVING last_observation_ts < ?
          AND held_claims_json != '[]'
          AND held_claims_json IS NOT NULL
       ORDER BY last_observation_ts ASC`,
    );
    this.recentToolErrorsStmt = this.db.prepare(
      `SELECT * FROM observations
       WHERE session_id = ?
         AND kind = 'tool_use'
         AND ts > ?
         AND (
           json_type(metadata, '$.error') IS NOT NULL
           OR lower(content) LIKE '%quota%'
           OR lower(content) LIKE '%rate%limit%'
           OR lower(content) LIKE '%approval%'
           OR lower(content) LIKE '%rejected%'
           OR lower(content) LIKE '%permission denied%'
         )
       ORDER BY ts DESC
       LIMIT ?`,
    );
    this.coordinationActivityStmt = this.db.prepare(
      `WITH tool_classes(tool, class) AS (
         SELECT value AS tool, 'commit' AS class FROM json_each(?)
         UNION ALL
         SELECT value AS tool, 'read' AS class FROM json_each(?)
       )
       SELECT o.session_id,
              tc.class,
              COUNT(*) AS count
       FROM observations o
       JOIN tool_classes tc
         ON tc.tool = COALESCE(
           json_extract(o.metadata, '$.tool_name'),
           json_extract(o.metadata, '$.tool')
         )
       WHERE o.ts >= ?
         AND o.kind = 'tool_use'
       GROUP BY o.session_id, tc.class
       ORDER BY tc.class ASC, count DESC, o.session_id ASC`,
    );
    this.editsWithoutClaimsStmt = this.db.prepare(
      `WITH edit_tools(tool) AS (
         SELECT value AS tool FROM json_each(?)
       )
       SELECT o.session_id,
              json_extract(o.metadata, '$.file_path') AS file_path,
              o.ts AS edit_ts,
              EXISTS (
                SELECT 1 FROM observations c
                WHERE c.kind = 'claim'
                  AND c.session_id = o.session_id
                  AND json_extract(c.metadata, '$.file_path') = json_extract(o.metadata, '$.file_path')
                  AND c.ts BETWEEN o.ts - ? AND o.ts + ?
              ) AS has_sibling_claim_within_window
       FROM observations o
       JOIN edit_tools et
         ON et.tool = COALESCE(
           json_extract(o.metadata, '$.tool_name'),
           json_extract(o.metadata, '$.tool')
         )
       WHERE o.ts >= ?
         AND o.kind = 'tool_use'
         AND json_extract(o.metadata, '$.file_path') IS NOT NULL
       ORDER BY o.ts DESC, o.id DESC`,
    );
    this.sessionsEndedWithoutHandoffStmt = this.db.prepare(
      `WITH last_obs AS (
         SELECT session_id,
                MAX(ts) AS last_observation_ts
         FROM observations
         WHERE ts >= ?
         GROUP BY session_id
       )
       SELECT l.session_id,
              l.last_observation_ts,
              EXISTS (
                SELECT 1 FROM task_claims tc
                WHERE tc.session_id = l.session_id
              ) AS had_active_claims,
              EXISTS (
                SELECT 1 FROM observations h
                WHERE h.session_id = l.session_id
                  AND h.kind IN ('handoff', 'relay')
                  AND h.ts <= l.last_observation_ts
              ) AS had_pending_handoff
       FROM last_obs l
       WHERE l.last_observation_ts <= ?
       ORDER BY l.last_observation_ts ASC, l.session_id ASC`,
    );
    if (!readonly && hasTaskEmbeddings) {
      this.upsertTaskEmbeddingStmt = this.db.prepare(
        `INSERT INTO task_embeddings(task_id, model, dim, embedding, observation_count, computed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           model = excluded.model,
           dim = excluded.dim,
           embedding = excluded.embedding,
           observation_count = excluded.observation_count,
           computed_at = excluded.computed_at`,
      );
    }
  }

  private tableExists(name: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(name) as { found: number } | undefined;
    return row !== undefined;
  }

  close(): void {
    this.db.close();
  }

  // --- sessions ---

  createSession(s: Omit<SessionRow, 'ended_at'>): void {
    // SessionStart re-fires on resume/clear/compact with the same session_id,
    // so preserve the original started_at / ended_at values. If a downstream
    // hook had to create an orphan row first, later richer hook payloads can
    // still fill in the IDE and cwd so colony/task binding is not lost.
    this.db
      .prepare(
        `INSERT INTO sessions(id, ide, cwd, started_at, metadata)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           ide = CASE
             WHEN sessions.ide = 'unknown' AND excluded.ide != 'unknown' THEN excluded.ide
             ELSE sessions.ide
           END,
           cwd = CASE
             WHEN sessions.cwd IS NULL AND excluded.cwd IS NOT NULL THEN excluded.cwd
             ELSE sessions.cwd
           END,
           metadata = CASE
             WHEN sessions.metadata IS NULL AND excluded.metadata IS NOT NULL THEN excluded.metadata
             ELSE sessions.metadata
           END`,
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

  /**
   * Walk every session row whose ide is `'unknown'` and, when the caller's
   * mapper returns a concrete IDE for that session_id, persist it. Used by
   * `colony backfill ide` to heal rows written before the on-demand
   * `MemoryStore.ensureSession` learned to infer the owner from the session
   * id itself. Returns `{ scanned, updated }` so the CLI can print an
   * honest summary instead of pretending every row was touched.
   */
  backfillUnknownIde(mapper: (sessionId: string) => string | undefined): {
    scanned: number;
    updated: number;
  } {
    const rows = this.db.prepare("SELECT id FROM sessions WHERE ide = 'unknown'").all() as Array<{
      id: string;
    }>;
    const update = this.db.prepare('UPDATE sessions SET ide = ? WHERE id = ? AND ide = ?');
    let updated = 0;
    const tx = this.db.transaction((pending: Array<{ id: string; ide: string }>) => {
      for (const row of pending) {
        const info = update.run(row.ide, row.id, 'unknown');
        if (info.changes > 0) updated += 1;
      }
    });
    const pending: Array<{ id: string; ide: string }> = [];
    for (const row of rows) {
      const next = mapper(row.id);
      if (next && next !== 'unknown') pending.push({ id: row.id, ide: next });
    }
    tx(pending);
    return { scanned: rows.length, updated };
  }

  findStrandedSessions(options: FindStrandedSessionsOptions = {}): StrandedSessionRow[] {
    const strandedAfterMs = options.stranded_after_ms ?? DEFAULT_STRANDED_AFTER_MS;
    const cutoff = Date.now() - strandedAfterMs;
    return this.findStrandedSessionsStmt.all(cutoff) as StrandedSessionRow[];
  }

  recentToolErrors(session_id: string, since_ts: number, limit = 20): ObservationRow[] {
    return this.recentToolErrorsStmt.all(session_id, since_ts, limit) as ObservationRow[];
  }

  coordinationActivity(since: number): CoordinationActivity {
    const rows = this.coordinationActivityStmt.all(
      COORDINATION_COMMIT_TOOLS_JSON,
      COORDINATION_READ_TOOLS_JSON,
      since,
    ) as Array<{ session_id: string; class: 'commit' | 'read'; count: number }>;
    const commits_by_session = new Map<string, number>();
    const reads_by_session = new Map<string, number>();
    let commits = 0;
    let reads = 0;
    for (const row of rows) {
      if (row.class === 'commit') {
        commits += row.count;
        commits_by_session.set(row.session_id, row.count);
      } else {
        reads += row.count;
        reads_by_session.set(row.session_id, row.count);
      }
    }
    return { commits, reads, commits_by_session, reads_by_session };
  }

  editsWithoutClaims(
    since: number,
    claim_window_ms = DEFAULT_CLAIM_WINDOW_MS,
  ): EditsWithoutClaimsRow[] {
    const rows = this.editsWithoutClaimsStmt.all(
      FILE_EDIT_TOOLS_JSON,
      claim_window_ms,
      claim_window_ms,
      since,
    ) as Array<{
      session_id: string;
      file_path: string;
      edit_ts: number;
      has_sibling_claim_within_window: 0 | 1;
    }>;
    return rows.map((row) => ({
      session_id: row.session_id,
      file_path: row.file_path,
      edit_ts: row.edit_ts,
      has_sibling_claim_within_window: row.has_sibling_claim_within_window === 1,
    }));
  }

  sessionsEndedWithoutHandoff(
    since: number,
    idle_window_ms = DEFAULT_IDLE_WINDOW_MS,
  ): SessionsEndedWithoutHandoffRow[] {
    const idleCutoff = Date.now() - idle_window_ms;
    const rows = this.sessionsEndedWithoutHandoffStmt.all(since, idleCutoff) as Array<{
      session_id: string;
      last_observation_ts: number;
      had_active_claims: 0 | 1;
      had_pending_handoff: 0 | 1;
    }>;
    return rows.map((row) => ({
      session_id: row.session_id,
      last_observation_ts: row.last_observation_ts,
      had_active_claims: row.had_active_claims === 1,
      had_pending_handoff: row.had_pending_handoff === 1,
    }));
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

  recentObservations(limit = 50): RecentObservationRow[] {
    return this.db
      .prepare(
        `SELECT o.id, o.session_id, o.kind, o.content, o.ts
         FROM observations o
         JOIN sessions s ON s.id = o.session_id
         ORDER BY o.ts DESC, o.id DESC
         LIMIT ?`,
      )
      .all(limit) as RecentObservationRow[];
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

  /**
   * BM25-ranked search. An optional `filter` scopes the hits to a specific
   * observation kind and/or to rows whose `metadata` JSON contains literal
   * string matches for the given keys. The filter runs in SQL via
   * `json_extract` so the LIMIT still bounds the scan.
   *
   * Design choice: we keep one method with an optional filter rather than
   * a separate `searchForagedFts`. Callers such as MCP `examples_query`
   * need filter support today, and every future kind-scoped search will
   * want the same wiring — branching here is cheaper than a new method
   * per caller.
   */
  searchFts(
    query: string,
    limit = 10,
    filter?: { kind?: string; metadata?: Record<string, string> },
  ): SearchHit[] {
    if (!query.trim()) return [];
    const conditions: string[] = ['observations_fts MATCH ?'];
    const params: Array<string | number> = [sanitizeMatch(query)];
    if (filter?.kind) {
      conditions.push('o.kind = ?');
      params.push(filter.kind);
    }
    if (filter?.metadata) {
      for (const [key, value] of Object.entries(filter.metadata)) {
        // Allow only simple identifier-shaped keys to keep JSON path safe.
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) continue;
        conditions.push(`json_extract(o.metadata, '$.${key}') = ?`);
        params.push(value);
      }
    }
    const where = conditions.join(' AND ');
    const rows = this.db
      .prepare(
        `SELECT o.id, o.session_id, o.kind, o.ts, o.task_id,
                snippet(observations_fts, 0, '[', ']', '…', 16) AS snippet,
                bm25(observations_fts) AS score
         FROM observations_fts
         JOIN observations o ON o.id = observations_fts.rowid
         WHERE ${where}
         ORDER BY score ASC
         LIMIT ?`,
      )
      .all(...params, limit) as Array<{
      id: number;
      session_id: string;
      kind: string;
      ts: number;
      task_id: number | null;
      snippet: string;
      score: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      kind: r.kind,
      snippet: r.snippet,
      // FTS5 bm25 is "lower is better". Flip sign so higher = better downstream.
      score: -r.score,
      ts: r.ts,
      task_id: r.task_id,
    }));
  }

  rebuildFts(): void {
    this.db.exec("INSERT INTO observations_fts(observations_fts) VALUES('rebuild');");
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

  // True iff an embedding row exists for this observation. Optional model
  // filter — without it, any model's row counts (only one model lives in
  // the table at a time anyway thanks to dropEmbeddingsWhereModelNot).
  hasEmbedding(observation_id: number, model?: string): boolean {
    if (model) {
      const row = this.db
        .prepare('SELECT 1 AS x FROM embeddings WHERE observation_id = ? AND model = ? LIMIT 1')
        .get(observation_id, model) as { x: number } | undefined;
      return row !== undefined;
    }
    const row = this.db
      .prepare('SELECT 1 AS x FROM embeddings WHERE observation_id = ? LIMIT 1')
      .get(observation_id) as { x: number } | undefined;
    return row !== undefined;
  }

  // --- task embeddings ---

  // The task embedding cache. Read on every similarity query, written
  // lazily when the cache is stale (drift > 20% on observation_count or
  // model mismatch). Conceptually a memoization table — the source of
  // truth is the task's observations + their embeddings.
  upsertTaskEmbedding(p: NewTaskEmbedding): void {
    const buf = Buffer.from(p.vec.buffer, p.vec.byteOffset, p.vec.byteLength);
    if (!this.upsertTaskEmbeddingStmt) throw new Error('storage is readonly');
    this.upsertTaskEmbeddingStmt.run(
      p.task_id,
      p.model,
      p.dim,
      buf,
      p.observation_count,
      p.computed_at ?? Date.now(),
    );
  }

  getTaskEmbedding(task_id: number): TaskEmbeddingRow | undefined {
    const row = this.getTaskEmbeddingStmt.get(task_id) as
      | {
          task_id: number;
          model: string;
          dim: number;
          embedding: Buffer;
          observation_count: number;
          computed_at: number;
        }
      | undefined;
    if (!row) return undefined;
    // Copy out of the better-sqlite3 buffer into an owned Float32Array —
    // see the same pattern in allEmbeddings(). The underlying buffer is
    // freed once the row goes out of scope, so we cannot alias it.
    const vec = new Float32Array(
      new Uint8Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength,
      ).slice().buffer,
    );
    return {
      task_id: row.task_id,
      model: row.model,
      dim: row.dim,
      vec,
      observation_count: row.observation_count,
      computed_at: row.computed_at,
    };
  }

  countTaskObservations(task_id: number): number {
    const row = this.countTaskObservationsStmt.get(task_id) as { n: number };
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

  /**
   * Claims made in the last `since_ts…now` window. Used by the conflict
   * preface to surface "someone else is ACTIVELY editing this" — stale
   * claims (outside the window) are intentionally excluded because they
   * describe work that's already finished, not live collisions.
   */
  recentClaims(task_id: number, since_ts: number, limit = 50): TaskClaimRow[] {
    return this.db
      .prepare(
        'SELECT * FROM task_claims WHERE task_id = ? AND claimed_at > ? ORDER BY claimed_at DESC LIMIT ?',
      )
      .all(task_id, since_ts, limit) as TaskClaimRow[];
  }

  // --- task links (cross-task edges) ---

  /**
   * Link two tasks bidirectionally. Stored once with (low_id, high_id) so
   * order doesn't matter to callers — `linkTasks(A, B)` and `linkTasks(B, A)`
   * collapse onto the same row. Idempotent: re-linking an existing pair is a
   * no-op (the original `created_by` / `created_at` / `note` are preserved).
   * Self-links are rejected — a task linking to itself is meaningless and
   * indicates a caller bug.
   */
  linkTasks(p: NewTaskLink): TaskLinkRow {
    if (p.task_id_a === p.task_id_b) {
      throw new Error('cannot link a task to itself');
    }
    const [low_id, high_id] =
      p.task_id_a < p.task_id_b ? [p.task_id_a, p.task_id_b] : [p.task_id_b, p.task_id_a];
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO task_links(low_id, high_id, created_by, created_at, note)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(low_id, high_id, p.created_by, now, p.note ?? null);
    return this.db
      .prepare('SELECT * FROM task_links WHERE low_id = ? AND high_id = ?')
      .get(low_id, high_id) as TaskLinkRow;
  }

  unlinkTasks(task_id_a: number, task_id_b: number): boolean {
    if (task_id_a === task_id_b) return false;
    const [low_id, high_id] =
      task_id_a < task_id_b ? [task_id_a, task_id_b] : [task_id_b, task_id_a];
    const info = this.db
      .prepare('DELETE FROM task_links WHERE low_id = ? AND high_id = ?')
      .run(low_id, high_id);
    return info.changes > 0;
  }

  /**
   * Tasks linked to `task_id`, regardless of which side originally created
   * the link. Returns the *other* task on each edge — never `task_id` itself
   * — and exposes the link's metadata (created_by, created_at, note) so a
   * preface can render "linked to #42 by claude — 'frontend ↔ backend lane'".
   */
  linkedTasks(task_id: number): LinkedTask[] {
    return this.db
      .prepare(
        `SELECT
           CASE WHEN low_id = ? THEN high_id ELSE low_id END AS task_id,
           created_at AS linked_at,
           created_by AS linked_by,
           note
         FROM task_links
         WHERE low_id = ? OR high_id = ?
         ORDER BY created_at DESC`,
      )
      .all(task_id, task_id, task_id) as LinkedTask[];
  }

  // --- pheromones (ambient decaying activity trails) ---

  /**
   * Write-or-overwrite a pheromone row. The caller computes the new strength
   * (decay + reinforcement) and passes both `strength` and `deposited_at`.
   * We don't merge on the SQL side because the decay constant lives in the
   * caller and we want a single source of truth for it.
   */
  upsertPheromone(p: NewPheromone): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO pheromones(task_id, file_path, session_id, strength, deposited_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(p.task_id, p.file_path, p.session_id, p.strength, p.deposited_at);
  }

  /** One pheromone row for (task, file, session) or undefined. */
  getPheromone(task_id: number, file_path: string, session_id: string): PheromoneRow | undefined {
    return this.db
      .prepare('SELECT * FROM pheromones WHERE task_id = ? AND file_path = ? AND session_id = ?')
      .get(task_id, file_path, session_id) as PheromoneRow | undefined;
  }

  /** Every pheromone row on a (task, file) across all sessions. */
  listPheromonesForFile(task_id: number, file_path: string): PheromoneRow[] {
    return this.db
      .prepare('SELECT * FROM pheromones WHERE task_id = ? AND file_path = ?')
      .all(task_id, file_path) as PheromoneRow[];
  }

  /** Every pheromone row on a task. Caller is expected to apply decay. */
  listPheromonesForTask(task_id: number): PheromoneRow[] {
    return this.db
      .prepare('SELECT * FROM pheromones WHERE task_id = ? ORDER BY deposited_at DESC')
      .all(task_id) as PheromoneRow[];
  }

  // --- proposals (pre-tasks that promote on collective reinforcement) ---

  /**
   * Insert a new pending proposal. `touches_files` is stored as JSON text —
   * the caller stringifies; we keep the blob opaque because SQLite has no
   * array type and JSON functions don't buy us enough to be worth the
   * indexing complexity at this scale.
   */
  insertProposal(p: NewProposal): number {
    const now = p.proposed_at ?? Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO proposals(repo_root, branch, summary, rationale, touches_files,
                                status, proposed_by, proposed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.repo_root,
        p.branch,
        p.summary,
        p.rationale,
        p.touches_files,
        p.status ?? 'pending',
        p.proposed_by,
        now,
      );
    return Number(info.lastInsertRowid);
  }

  getProposal(id: number): ProposalRow | undefined {
    return this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as
      | ProposalRow
      | undefined;
  }

  /**
   * Update a proposal's status and optional promotion fields. Designed for
   * the promotion path: (status='active', promoted_at=..., task_id=...).
   */
  updateProposal(
    id: number,
    patch: { status?: ProposalStatus; promoted_at?: number | null; task_id?: number | null },
  ): void {
    const current = this.getProposal(id);
    if (!current) return;
    const next = {
      status: patch.status ?? current.status,
      promoted_at: patch.promoted_at === undefined ? current.promoted_at : patch.promoted_at,
      task_id: patch.task_id === undefined ? current.task_id : patch.task_id,
    };
    this.db
      .prepare('UPDATE proposals SET status = ?, promoted_at = ?, task_id = ? WHERE id = ?')
      .run(next.status, next.promoted_at, next.task_id, id);
  }

  /** Every proposal on a (repo_root, branch). Ordered newest-first. */
  listProposalsForBranch(repo_root: string, branch: string): ProposalRow[] {
    return this.db
      .prepare(
        'SELECT * FROM proposals WHERE repo_root = ? AND branch = ? ORDER BY proposed_at DESC',
      )
      .all(repo_root, branch) as ProposalRow[];
  }

  /** Every proposal, optionally scoped to a repository. Ordered newest-first. */
  listProposals(repo_root?: string): ProposalRow[] {
    if (repo_root !== undefined) {
      return this.db
        .prepare('SELECT * FROM proposals WHERE repo_root = ? ORDER BY proposed_at DESC')
        .all(repo_root) as ProposalRow[];
    }
    return this.db
      .prepare('SELECT * FROM proposals ORDER BY proposed_at DESC')
      .all() as ProposalRow[];
  }

  // --- proposal reinforcements ---

  insertReinforcement(r: NewReinforcement): void {
    this.db
      .prepare(
        `INSERT INTO proposal_reinforcements
           (proposal_id, session_id, kind, weight, reinforced_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(r.proposal_id, r.session_id, r.kind, r.weight, r.reinforced_at);
  }

  listReinforcements(proposal_id: number): ReinforcementRow[] {
    return this.db
      .prepare('SELECT * FROM proposal_reinforcements WHERE proposal_id = ?')
      .all(proposal_id) as ReinforcementRow[];
  }

  // --- agent profiles (response-threshold routing) ---

  /**
   * Upsert an agent's capability profile. Last-writer-wins — agents
   * adjust their own profile as they settle on what they do well, and
   * there's no meaningful "merge" semantics between two different views
   * of the same agent's own capabilities.
   */
  upsertAgentProfile(p: NewAgentProfile): void {
    const now = p.updated_at ?? Date.now();
    this.db
      .prepare(
        'INSERT OR REPLACE INTO agent_profiles(agent, capabilities, updated_at) VALUES (?, ?, ?)',
      )
      .run(p.agent, p.capabilities, now);
  }

  getAgentProfile(agent: string): AgentProfileRow | undefined {
    return this.db.prepare('SELECT * FROM agent_profiles WHERE agent = ?').get(agent) as
      | AgentProfileRow
      | undefined;
  }

  listAgentProfiles(): AgentProfileRow[] {
    return this.db
      .prepare('SELECT * FROM agent_profiles ORDER BY agent ASC')
      .all() as AgentProfileRow[];
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

  // --- foraging food sources (indexed <repo_root>/examples/<name>) ---

  /**
   * Insert-or-replace an `examples` row for a (repo_root, example_name).
   * The scanner owns `content_hash` semantics — we accept whatever it
   * computes and last-writer-wins. Replacing the row (rather than merging)
   * matches the data's identity: a food source is defined by its current
   * content, so stale metadata must not survive a rescan.
   */
  upsertExample(e: NewExample): number {
    const now = e.last_scanned_at ?? Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO examples(repo_root, example_name, content_hash, manifest_kind,
                              last_scanned_at, observation_count)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_root, example_name) DO UPDATE SET
           content_hash      = excluded.content_hash,
           manifest_kind     = excluded.manifest_kind,
           last_scanned_at   = excluded.last_scanned_at,
           observation_count = excluded.observation_count
         RETURNING id`,
      )
      .get(
        e.repo_root,
        e.example_name,
        e.content_hash,
        e.manifest_kind,
        now,
        e.observation_count ?? 0,
      ) as { id: number };
    return info.id;
  }

  /** One example row for (repo_root, example_name) or undefined. */
  getExample(repo_root: string, example_name: string): ExampleRow | undefined {
    return this.db
      .prepare('SELECT * FROM examples WHERE repo_root = ? AND example_name = ?')
      .get(repo_root, example_name) as ExampleRow | undefined;
  }

  /** Every example for a repo, newest-scan-first. */
  listExamples(repo_root: string): ExampleRow[] {
    return this.db
      .prepare('SELECT * FROM examples WHERE repo_root = ? ORDER BY last_scanned_at DESC')
      .all(repo_root) as ExampleRow[];
  }

  /** Delete a single food source's row. Observations are kept — the caller
   *  (CLI `foraging clear`) decides whether to purge those separately. */
  deleteExample(repo_root: string, example_name: string): void {
    this.db
      .prepare('DELETE FROM examples WHERE repo_root = ? AND example_name = ?')
      .run(repo_root, example_name);
  }

  /**
   * Drop every `foraged-pattern` observation that belongs to a food
   * source. Called by the indexer before re-indexing a changed example —
   * without it, each rescan would accumulate a parallel copy of the
   * same content. Returns the number of rows deleted.
   */
  deleteForagedObservations(repo_root: string, example_name: string): number {
    const info = this.db
      .prepare(
        `DELETE FROM observations
         WHERE kind = 'foraged-pattern'
           AND json_extract(metadata, '$.repo_root') = ?
           AND json_extract(metadata, '$.example_name') = ?`,
      )
      .run(repo_root, example_name);
    return Number(info.changes);
  }

  /**
   * All `foraged-pattern` observations for a (repo_root, example_name).
   * Ordered oldest→newest so the MCP `examples_query` consumers (and
   * tests here) see a stable shape.
   */
  listForagedObservations(repo_root: string, example_name: string): ObservationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM observations
         WHERE kind = 'foraged-pattern'
           AND json_extract(metadata, '$.repo_root') = ?
           AND json_extract(metadata, '$.example_name') = ?
         ORDER BY ts ASC`,
      )
      .all(repo_root, example_name) as ObservationRow[];
  }

  // --- observe / debrief analytics ---
  //
  // These are read-heavy queries serving the CLI dashboards. They stay on
  // the Storage class (not a separate analytics module) because they work
  // on the same prepared-statement cache and benefit from colocation with
  // the tables they query.

  /** Pending, non-expired handoffs on a task. */
  pendingHandoffs(task_id: number): ObservationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM observations
         WHERE task_id = ? AND kind = 'handoff'
           AND json_extract(metadata, '$.status') = 'pending'
           AND COALESCE(CAST(json_extract(metadata, '$.expires_at') AS INTEGER), ts + 7200000) > ?
         ORDER BY ts DESC LIMIT 50`,
      )
      .all(task_id, Date.now()) as ObservationRow[];
  }

  /**
   * Recent write-tool observations whose file wasn't explicitly claimed by
   * the agent that edited it. "Claimed" here means an explicit `claim`-kind
   * observation — not the auto-claim side effect — so the query measures
   * proactive behavior, not the automatic safety net.
   */
  recentEditsWithoutClaims(
    since_ts: number,
    limit = 20,
  ): Array<{ session_id: string; file_path: string; ts: number; task_id: number | null }> {
    return this.db
      .prepare(
        `SELECT o.session_id,
                json_extract(o.metadata, '$.file_path') AS file_path,
                o.ts,
                o.task_id
         FROM observations o
         WHERE o.kind = 'tool_use'
           AND o.ts > ?
           AND json_extract(o.metadata, '$.file_path') IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM observations c
             WHERE c.kind = 'claim'
               AND c.session_id = o.session_id
               AND json_extract(c.metadata, '$.file_path') = json_extract(o.metadata, '$.file_path')
               AND c.ts <= o.ts
           )
         ORDER BY o.ts DESC
         LIMIT ?`,
      )
      .all(since_ts, limit) as Array<{
      session_id: string;
      file_path: string;
      ts: number;
      task_id: number | null;
    }>;
  }

  /** Per-session activity since `since_ts`, split into total observations
   *  and task-thread-tagged observations. Ratio is the debrief's first
   *  signal of whether an agent found the tools at all. */
  toolUsageBySession(
    since_ts: number,
  ): Array<{ session_id: string; total_obs: number; task_tool_obs: number }> {
    return this.db
      .prepare(
        `SELECT
           session_id,
           COUNT(*) AS total_obs,
           SUM(CASE WHEN task_id IS NOT NULL THEN 1 ELSE 0 END) AS task_tool_obs
         FROM observations
         WHERE ts > ? AND session_id != 'observer'
         GROUP BY session_id
         ORDER BY total_obs DESC`,
      )
      .all(since_ts) as Array<{
      session_id: string;
      total_obs: number;
      task_tool_obs: number;
    }>;
  }

  /** Per-tool invocation count since `since_ts`, sorted descending. Built-in
   *  tools (Edit, Read, Bash, …) and MCP tools (mcp__<server>__<tool>) appear
   *  in the same list — the prefix is enough to tell them apart visually.
   *  Surfaced by `debrief` so build/cut decisions about MCP tool surface area
   *  can lean on actual call counts instead of intuition. */
  toolInvocationDistribution(since_ts: number, limit = 50): Array<{ tool: string; count: number }> {
    return this.db
      .prepare(
        `SELECT json_extract(metadata, '$.tool') AS tool, COUNT(*) AS count
         FROM observations
         WHERE ts > ? AND kind = 'tool_use'
           AND json_extract(metadata, '$.tool') IS NOT NULL
         GROUP BY tool
         ORDER BY count DESC, tool ASC
         LIMIT ?`,
      )
      .all(since_ts, limit) as Array<{ tool: string; count: number }>;
  }

  /** Ordered tool calls for lightweight local health/adoption ratios. */
  toolCallsSince(since_ts: number): ToolCallRow[] {
    return this.db
      .prepare(
        `SELECT id,
                session_id,
                COALESCE(json_extract(metadata, '$.tool'), json_extract(metadata, '$.tool_name')) AS tool,
                ts
         FROM observations
         WHERE ts > ?
           AND kind = 'tool_use'
           AND COALESCE(json_extract(metadata, '$.tool'), json_extract(metadata, '$.tool_name')) IS NOT NULL
         ORDER BY ts ASC, id ASC`,
      )
      .all(since_ts) as ToolCallRow[];
  }

  /**
   * Exact proactive-claim coverage for write tools when file_path metadata is
   * present. Callers should treat partial metadata as unavailable rather than
   * inferring from content.
   */
  claimBeforeEditStats(since_ts: number): ClaimBeforeEditStats {
    const row = this.db
      .prepare(
        `WITH edit_tools(tool) AS (
           SELECT value AS tool FROM json_each(?)
         ),
         edit_rows AS (
           SELECT o.session_id,
                  o.ts,
                  json_extract(o.metadata, '$.file_path') AS file_path
           FROM observations o
           JOIN edit_tools et
             ON et.tool = COALESCE(
               json_extract(o.metadata, '$.tool'),
               json_extract(o.metadata, '$.tool_name')
             )
           WHERE o.ts > ?
             AND o.kind = 'tool_use'
         )
         SELECT COUNT(*) AS edit_tool_calls,
                SUM(CASE WHEN file_path IS NOT NULL THEN 1 ELSE 0 END) AS edits_with_file_path,
                SUM(CASE WHEN file_path IS NOT NULL AND EXISTS (
                  SELECT 1 FROM observations c
                  WHERE c.kind = 'claim'
                    AND c.session_id = edit_rows.session_id
                    AND json_extract(c.metadata, '$.file_path') = edit_rows.file_path
                    AND c.ts <= edit_rows.ts
                ) THEN 1 ELSE 0 END) AS edits_claimed_before,
                (
                  SELECT COUNT(*) FROM observations c
                  WHERE c.ts > ?
                    AND c.kind = 'claim'
                    AND json_extract(c.metadata, '$.source') = 'pre-tool-use'
                    AND json_extract(c.metadata, '$.auto_claimed_before_edit') = 1
                ) AS auto_claimed_before_edit,
                (
                  SELECT COUNT(*) FROM observations c
                  WHERE c.ts > ?
                    AND c.kind = 'claim-before-edit'
                    AND json_extract(c.metadata, '$.session_binding_missing') = 1
                ) AS session_binding_missing,
                (
                  SELECT COUNT(*) FROM observations c
                  WHERE c.ts > ?
                    AND c.kind = 'claim-before-edit'
                ) AS pre_tool_use_signals
         FROM edit_rows`,
      )
      .get(FILE_EDIT_TOOLS_JSON, since_ts, since_ts, since_ts, since_ts) as {
      edit_tool_calls: number;
      edits_with_file_path: number | null;
      edits_claimed_before: number | null;
      auto_claimed_before_edit: number | null;
      session_binding_missing: number | null;
      pre_tool_use_signals: number | null;
    };
    return {
      edit_tool_calls: row.edit_tool_calls,
      edits_with_file_path: row.edits_with_file_path ?? 0,
      edits_claimed_before: row.edits_claimed_before ?? 0,
      auto_claimed_before_edit: row.auto_claimed_before_edit ?? 0,
      session_binding_missing: row.session_binding_missing ?? 0,
      pre_tool_use_signals: row.pre_tool_use_signals ?? 0,
    };
  }

  /** First task-participant row for a session, used to verify auto-join
   *  fired within ~2s of SessionStart. */
  participantJoinFor(session_id: string): TaskParticipantRow | undefined {
    return this.db
      .prepare(
        'SELECT * FROM task_participants WHERE session_id = ? ORDER BY joined_at ASC LIMIT 1',
      )
      .get(session_id) as TaskParticipantRow | undefined;
  }

  /** Edit count vs explicit-claim count — the critical diagnostic for
   *  whether proactive claiming is working in the wild. */
  editVsClaimStats(since_ts: number): { edit_count: number; claim_count: number } {
    const coverage = this.claimCoverageStats(since_ts);
    return { edit_count: coverage.edit_count, claim_count: coverage.explicit_claim_count };
  }

  /** Edit count split by explicit claim observations and auto-claim observations. */
  claimCoverageStats(since_ts: number): ClaimCoverageStats {
    const edit = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM observations
         WHERE ts > ? AND kind = 'tool_use'
           AND json_extract(metadata, '$.file_path') IS NOT NULL`,
      )
      .get(since_ts) as { n: number };
    const claimRows = this.db
      .prepare(
        `SELECT kind, COUNT(*) AS count
         FROM observations
         WHERE ts > ? AND kind IN ('claim', 'auto-claim')
         GROUP BY kind
         ORDER BY kind ASC`,
      )
      .all(since_ts) as KindCount[];
    const explicit_claim_kinds = kindCountsWithZeroes(EXPLICIT_CLAIM_KINDS, claimRows);
    const auto_claim_kinds = kindCountsWithZeroes(AUTO_CLAIM_KINDS, claimRows);
    return {
      edit_count: edit.n,
      explicit_claim_count: sumKindCounts(explicit_claim_kinds),
      auto_claim_count: sumKindCounts(auto_claim_kinds),
      explicit_claim_kinds,
      auto_claim_kinds,
    };
  }

  /** Viewer diagnostic snapshot, computed in one grouped SQL scan. */
  claimCoverageSnapshot(since_ts: number): ClaimCoverageSnapshot {
    const rows = this.db
      .prepare(
        `SELECT kind, COUNT(*) AS count
         FROM observations
         WHERE ts > ?
           AND (
             kind IN ('auto-claim', 'claim', 'claim-conflict', 'git-op', 'file-op')
             OR (
               kind = 'tool_use'
               AND json_extract(metadata, '$.tool') IN ('Edit', 'Write')
             )
           )
         GROUP BY kind`,
      )
      .all(since_ts) as KindCount[];
    const count = (kind: string): number => rows.find((row) => row.kind === kind)?.count ?? 0;
    const bash_git_op_count = count('git-op');
    const bash_file_op_count = count('file-op');
    return {
      since: since_ts,
      until: Date.now(),
      edit_write_count: count('tool_use'),
      auto_claim_count: count('auto-claim'),
      explicit_claim_count: count('claim'),
      claim_conflict_count: count('claim-conflict'),
      bash_git_op_count,
      bash_file_op_count,
      bash_git_file_op_count: bash_git_op_count + bash_file_op_count,
    };
  }

  /** Bash-derived coordination observations from the PostToolUse parser. */
  bashCoordinationVolume(since_ts: number, file_limit = 5): BashCoordinationVolume {
    const counts = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN kind = 'git-op' THEN 1 ELSE 0 END) AS git_op_count,
           SUM(CASE WHEN kind = 'file-op' THEN 1 ELSE 0 END) AS file_op_count
         FROM observations
         WHERE ts > ? AND kind IN ('git-op', 'file-op')`,
      )
      .get(since_ts) as { git_op_count: number | null; file_op_count: number | null };
    const topFiles = this.db
      .prepare(
        `WITH file_paths AS (
           SELECT fp.value AS file_path
           FROM observations o
           JOIN json_each(
             CASE
               WHEN json_type(o.metadata, '$.file_paths') = 'array'
                 THEN json_extract(o.metadata, '$.file_paths')
               WHEN json_extract(o.metadata, '$.file_path') IS NOT NULL
                 THEN json_array(json_extract(o.metadata, '$.file_path'))
               ELSE json_array()
             END
           ) fp
           WHERE o.ts > ? AND o.kind = 'file-op'
         )
         SELECT file_path, COUNT(*) AS count
         FROM file_paths
         WHERE file_path IS NOT NULL AND file_path != ''
         GROUP BY file_path
         ORDER BY count DESC, file_path ASC
         LIMIT ?`,
      )
      .all(since_ts, file_limit) as Array<{ file_path: string; count: number }>;
    return {
      git_op_count: counts.git_op_count ?? 0,
      file_op_count: counts.file_op_count ?? 0,
      top_files_by_file_op: topFiles,
    };
  }

  /**
   * Decaying file activity heat for task context surfaces. Heat is computed
   * from durable observations plus current claim rows, so no background job
   * or cleanup pass is needed: old activity fades at read time.
   */
  fileHeat(opts: FileHeatOptions): FileHeatRow[] {
    const now = opts.now ?? Date.now();
    const halfLifeMinutes = Number.isFinite(opts.half_life_minutes) ? opts.half_life_minutes : 30;
    const halfLifeMs = Math.max(1, halfLifeMinutes) * 60_000;
    const since = now - halfLifeMs * FILE_HEAT_LOOKBACK_HALF_LIVES;
    const minHeat = opts.min_heat ?? DEFAULT_FILE_HEAT_MIN_HEAT;
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_FILE_HEAT_LIMIT, 100));
    const taskIds = normalizeTaskIds(opts.task_ids);
    const taskFilter = buildTaskFilter('task_id', taskIds);

    const observations = this.db
      .prepare(
        `SELECT task_id, kind, ts, metadata
         FROM observations
         WHERE task_id IS NOT NULL
           AND ts >= ?
           AND metadata IS NOT NULL
           ${taskFilter.sql}
         ORDER BY ts DESC`,
      )
      .all(since, ...taskFilter.params) as Array<{
      task_id: number;
      kind: string;
      ts: number;
      metadata: string;
    }>;

    const claims = this.db
      .prepare(
        `SELECT task_id, file_path, claimed_at
         FROM task_claims
         WHERE claimed_at >= ?
           ${taskFilter.sql}
         ORDER BY claimed_at DESC`,
      )
      .all(since, ...taskFilter.params) as Array<{
      task_id: number;
      file_path: string;
      claimed_at: number;
    }>;

    const byFile = new Map<string, FileHeatRow>();
    for (const row of observations) {
      const meta = parseMetadata(row.metadata);
      if (!meta) continue;
      const weight = fileHeatWeight(row.kind);
      for (const filePath of extractHeatFilePaths(meta)) {
        addHeat(byFile, {
          task_id: row.task_id,
          file_path: filePath,
          ts: row.ts,
          heat: decayedFileHeat(weight, row.ts, now, halfLifeMs),
        });
      }
    }
    for (const claim of claims) {
      addHeat(byFile, {
        task_id: claim.task_id,
        file_path: claim.file_path,
        ts: claim.claimed_at,
        heat: decayedFileHeat(1, claim.claimed_at, now, halfLifeMs),
      });
    }

    return Array.from(byFile.values())
      .filter((row) => row.heat >= minHeat)
      .sort(
        (a, b) =>
          b.heat - a.heat ||
          b.last_activity_ts - a.last_activity_ts ||
          a.file_path.localeCompare(b.file_path),
      )
      .slice(0, limit);
  }

  /** Count of handoffs by final status in the window. */
  handoffStatusDistribution(since_ts: number): {
    accepted: number;
    cancelled: number;
    expired: number;
    pending: number;
  } {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN json_extract(metadata, '$.status') = 'accepted'  THEN 1 ELSE 0 END) AS accepted,
           SUM(CASE WHEN json_extract(metadata, '$.status') = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
           SUM(CASE WHEN json_extract(metadata, '$.status') = 'expired'   THEN 1 ELSE 0 END) AS expired,
           SUM(CASE WHEN json_extract(metadata, '$.status') = 'pending'   THEN 1 ELSE 0 END) AS pending
         FROM observations WHERE ts > ? AND kind = 'handoff'`,
      )
      .get(since_ts) as {
      accepted: number | null;
      cancelled: number | null;
      expired: number | null;
      pending: number | null;
    };
    return {
      accepted: row.accepted ?? 0,
      cancelled: row.cancelled ?? 0,
      expired: row.expired ?? 0,
      pending: row.pending ?? 0,
    };
  }

  /** Milliseconds between handoff post and accept, for accepted handoffs. */
  handoffAcceptLatencies(since_ts: number): number[] {
    const rows = this.db
      .prepare(
        `SELECT (json_extract(metadata, '$.accepted_at') - ts) AS latency_ms
         FROM observations
         WHERE ts > ? AND kind = 'handoff'
           AND json_extract(metadata, '$.status') = 'accepted'
           AND json_extract(metadata, '$.accepted_at') IS NOT NULL`,
      )
      .all(since_ts) as Array<{ latency_ms: number }>;
    return rows.map((r) => r.latency_ms).filter((n) => Number.isFinite(n) && n >= 0);
  }

  /** Mixed-source timeline (agent activity + observer notes) ordered
   *  oldest → newest so the debrief reads as a chronological story. */
  mixedTimeline(since_ts: number, task_id?: number, limit = 200): ObservationRow[] {
    if (task_id !== undefined) {
      return this.db
        .prepare('SELECT * FROM observations WHERE ts > ? AND task_id = ? ORDER BY ts ASC LIMIT ?')
        .all(since_ts, task_id, limit) as ObservationRow[];
    }
    return this.db
      .prepare('SELECT * FROM observations WHERE ts > ? ORDER BY ts ASC LIMIT ?')
      .all(since_ts, limit) as ObservationRow[];
  }
}

function kindCountsWithZeroes(kinds: string[], rows: KindCount[]): KindCount[] {
  return kinds.map((kind) => ({
    kind,
    count: rows.find((row) => row.kind === kind)?.count ?? 0,
  }));
}

function sumKindCounts(rows: KindCount[]): number {
  return rows.reduce((sum, row) => sum + row.count, 0);
}

function normalizeTaskIds(taskIds: number[] | undefined): number[] {
  if (!taskIds) return [];
  return [...new Set(taskIds.filter((id) => Number.isInteger(id) && id > 0))];
}

function buildTaskFilter(column: string, taskIds: number[]): { sql: string; params: number[] } {
  if (taskIds.length === 0) return { sql: '', params: [] };
  return {
    sql: `AND ${column} IN (${taskIds.map(() => '?').join(', ')})`,
    params: taskIds,
  };
}

function parseMetadata(raw: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractHeatFilePaths(meta: JsonRecord): string[] {
  const out = new Set<string>();
  for (const key of [
    'file_path',
    'file_paths',
    'file_scope',
    'transferred_files',
    'released_files',
    'touches_files',
  ]) {
    collectFilePaths(meta[key], out);
  }
  return Array.from(out);
}

function collectFilePaths(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) out.add(trimmed);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed) out.add(trimmed);
  }
}

function fileHeatWeight(kind: string): number {
  if (kind === 'tool_use' || kind === 'file-op') return 1;
  // Active claim rows are folded in separately. Ignore claim observations
  // here so a fresh claim is one signal, not double-counted bookkeeping.
  if (kind === 'claim' || kind === 'auto-claim') return 0;
  if (kind === 'claim-conflict') return 1;
  if (kind === 'handoff' || kind === 'relay' || kind.startsWith('plan-')) return 0.5;
  return 0.25;
}

function decayedFileHeat(weight: number, ts: number, now: number, halfLifeMs: number): number {
  const age = Math.max(0, now - ts);
  return weight * 0.5 ** (age / halfLifeMs);
}

function addHeat(
  byFile: Map<string, FileHeatRow>,
  event: { task_id: number; file_path: string; ts: number; heat: number },
): void {
  if (!event.file_path || event.heat <= 0 || !Number.isFinite(event.heat)) return;
  const key = `${event.task_id}\0${event.file_path}`;
  const current = byFile.get(key);
  if (!current) {
    byFile.set(key, {
      task_id: event.task_id,
      file_path: event.file_path,
      heat: event.heat,
      last_activity_ts: event.ts,
      event_count: 1,
    });
    return;
  }
  current.heat += event.heat;
  current.last_activity_ts = Math.max(current.last_activity_ts, event.ts);
  current.event_count += 1;
}

function sanitizeMatch(q: string): string {
  // Escape double quotes and wrap each bare term to avoid FTS5 syntax errors.
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}
