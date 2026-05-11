/// <reference path="./better-sqlite3.d.ts" />

import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { normalizeClaimPath } from './claim-path.js';
import { COLUMN_MIGRATIONS, POST_MIGRATION_SQL, SCHEMA_SQL } from './schema.js';
import {
  COORDINATION_COMMIT_TOOLS,
  COORDINATION_READ_TOOLS,
  FILE_EDIT_TOOLS,
} from './tool-classes.js';
import type {
  AccountClaimRow,
  AccountClaimState,
  AgentProfileRow,
  AggregateMcpMetricsOptions,
  ExampleRow,
  LaneRunState,
  LaneStateRow,
  LaneTakeoverResult,
  LinkedTask,
  McpMetricsAggregate,
  McpMetricsAggregateRow,
  McpMetricsCostBasis,
  McpMetricsErrorReason,
  McpMetricsErrorReasonRawRow,
  McpMetricsOperationRawRow,
  McpMetricsRawRow,
  McpMetricsSessionAggregateRow,
  McpMetricsSessionRawRow,
  McpMetricsSessionSummary,
  NewAccountClaim,
  NewAgentProfile,
  NewExample,
  NewMcpMetric,
  NewObservation,
  NewPheromone,
  NewProposal,
  NewReinforcement,
  NewSummary,
  NewTask,
  NewTaskEmbedding,
  NewTaskLink,
  ObservationRow,
  PausedLaneRow,
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

/**
 * Branch names treated as protected base branches across the agent
 * coordination surface. Claims, edits, and lane starts on these branches
 * are flagged as worktree-discipline violations: the contract is that
 * every task — even a typo — runs on a dedicated `agent/*` branch in a
 * worktree. The constant is exported so non-storage callers (hooks,
 * MCP, CLI) all use the same definition instead of drifting copies.
 */
export const PROTECTED_BRANCH_NAMES: ReadonlySet<string> = new Set([
  'main',
  'master',
  'dev',
  'develop',
  'production',
  'release',
]);

/**
 * Whether a branch name is one of the protected base branches. Trims
 * and lowercases the input so callers don't have to normalize before
 * asking. Empty/null/undefined returns false.
 */
export function isProtectedBranch(branch: string | null | undefined): boolean {
  if (typeof branch !== 'string') return false;
  const trimmed = branch.trim().toLowerCase();
  if (trimmed.length === 0) return false;
  return PROTECTED_BRANCH_NAMES.has(trimmed);
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

export interface OmxRuntimeSummaryStats {
  status: 'available' | 'unavailable';
  summaries_ingested: number;
  latest_summary_ts: number | null;
  warning_count: number;
}

export interface OmxRuntimeWarningRow {
  id: number;
  task_id: number | null;
  session_id: string;
  ts: number;
  content: string;
  warnings: string[];
  quota_warning: string | null;
  runtime_model_error: string | null;
  last_failed_tool: unknown;
  active_file_focus: string[];
}

export interface ClaimBeforeEditStats {
  edit_tool_calls: number;
  edits_with_file_path: number;
  edits_claimed_before: number;
  claim_match_window_ms?: number;
  claim_match_sources?: Partial<ClaimMatchSources>;
  claim_miss_reasons?: Partial<ClaimMissReasons>;
  nearest_claim_examples?: NearestClaimExample[];
  auto_claimed_before_edit?: number;
  /** Count of PreToolUse claim-before-edit rows that had to be recorded under
   *  a fallback diagnostics session because the hook session row was missing. */
  session_binding_missing?: number;
  /** Count of `claim-before-edit` telemetry observations in the window — any
   *  outcome (success, conflict, failure). Authoritative signal that the
   *  PreToolUse hook is firing at all in the active editor sessions. */
  pre_tool_use_signals?: number;
}

export interface ClaimMatchSources {
  exact_session: number;
  repo_branch: number;
  worktree: number;
  agent_lane: number;
}

export interface ClaimMissReasons {
  no_claim_for_file: number;
  claim_after_edit: number;
  session_id_mismatch: number;
  repo_root_mismatch: number;
  branch_mismatch: number;
  path_mismatch: number;
  worktree_path_mismatch: number;
  pseudo_path_skipped: number;
  pre_tool_use_missing: number;
}

export interface NearestClaimExample {
  reason: keyof ClaimMissReasons;
  edit_id: number;
  edit_session_id: string;
  edit_file_path: string | null;
  edit_repo_root: string | null;
  edit_branch: string | null;
  edit_worktree_path: string | null;
  edit_ts: number;
  nearest_claim_id: number | null;
  claim_session_id: string | null;
  claim_file_path: string | null;
  claim_repo_root: string | null;
  claim_branch: string | null;
  claim_worktree_path: string | null;
  claim_ts: number | null;
  distance_ms: number | null;
  relation: {
    same_file_path: boolean;
    same_session_id: boolean;
    same_repo_root: boolean | null;
    same_branch: boolean | null;
    same_worktree_path: boolean | null;
    claim_before_edit: boolean | null;
  };
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
const DEFAULT_NEAREST_CLAIM_EXAMPLE_LIMIT = 50;
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

interface ClaimBeforeEditRow {
  id: number;
  session_id: string;
  ts: number;
  file_path: string | null;
  repo_root: string | null;
  branch: string | null;
  worktree_path: string | null;
  agent_identity: string | null;
}

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
  private taskClaimColumns = new Set<string>();

  constructor(dbPath: string, opts: StorageOptions = {}) {
    if (!opts.readonly) mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, opts.readonly ? { readonly: true } : {});
    // busy_timeout is connection-scoped. Multiple processes (worker daemon,
    // MCP server, CLI hooks) hit the same WAL file; without this they trip
    // SQLITE_BUSY immediately on contention. 5s lets the kernel retry.
    this.db.pragma('busy_timeout = 5000');
    if (opts.readonly) {
      this.db.pragma('foreign_keys = ON');
    } else {
      this.db.exec(SCHEMA_SQL);
      this.applyTableMigrations();
      this.applyColumnMigrations();
      this.migrateTaskClaimWeakExpiredState();
      this.db.exec(POST_MIGRATION_SQL);
    }
    this.taskClaimColumns = this.tableColumns('task_claims');
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

  private migrateTaskClaimWeakExpiredState(): void {
    if (!this.tableExists('task_claims')) return;
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'task_claims'")
      .get() as { sql: string | null } | undefined;
    if (row?.sql?.includes("'weak_expired'")) return;

    this.db.pragma('foreign_keys = OFF');
    try {
      this.db.exec(`
        BEGIN;
        DROP INDEX IF EXISTS idx_task_claims_session;
        ALTER TABLE task_claims RENAME TO task_claims_old;
        CREATE TABLE task_claims (
          task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          file_path TEXT NOT NULL,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          claimed_at INTEGER NOT NULL,
          state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','handoff_pending','weak_expired')),
          expires_at INTEGER,
          handoff_observation_id INTEGER REFERENCES observations(id) ON DELETE SET NULL,
          PRIMARY KEY (task_id, file_path)
        );
        INSERT INTO task_claims(
          task_id, file_path, session_id, claimed_at, state, expires_at, handoff_observation_id
        )
          SELECT task_id, file_path, session_id, claimed_at, state, expires_at, handoff_observation_id
          FROM task_claims_old;
        DROP TABLE task_claims_old;
        CREATE INDEX IF NOT EXISTS idx_task_claims_session ON task_claims(session_id);
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
      if (this.tableColumns(table).has(column)) continue;
      this.db.exec(sql);
    }
  }

  private tableColumns(table: string): Set<string> {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(cols.map((col) => col.name));
  }

  private prepareTaskEmbeddingStatements(readonly: boolean): void {
    const hasTaskEmbeddings = this.tableExists('task_embeddings');
    const activeClaimPredicate = this.taskClaimColumns.has('state')
      ? "AND tc.state = 'active'"
      : '';
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
	                  ${activeClaimPredicate}
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
             WHEN sessions.ide IN ('unknown', 'unbound') AND excluded.ide NOT IN ('unknown', 'unbound') THEN excluded.ide
             ELSE sessions.ide
           END,
           cwd = CASE
             WHEN sessions.cwd IS NULL AND excluded.cwd IS NOT NULL THEN excluded.cwd
             ELSE sessions.cwd
           END,
           metadata = CASE
             WHEN sessions.metadata IS NULL AND excluded.metadata IS NOT NULL THEN excluded.metadata
             WHEN json_extract(sessions.metadata, '$.source') LIKE 'process-env:%'
               AND json_extract(excluded.metadata, '$.source') = 'omx-active-session'
               THEN excluded.metadata
             WHEN sessions.ide IN ('unknown', 'unbound')
               AND excluded.ide NOT IN ('unknown', 'unbound')
               AND excluded.metadata IS NOT NULL THEN excluded.metadata
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

  omxRuntimeSummaryStats(since_ts: number): OmxRuntimeSummaryStats {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS summaries_ingested,
                MAX(ts) AS latest_summary_ts,
                SUM(COALESCE(json_extract(metadata, '$.warning_count'), 0)) AS warning_count
         FROM observations
         WHERE kind = 'omx-runtime-summary'
           AND ts > ?`,
      )
      .get(since_ts) as {
      summaries_ingested: number;
      latest_summary_ts: number | null;
      warning_count: number | null;
    };
    return {
      status: row.summaries_ingested > 0 ? 'available' : 'unavailable',
      summaries_ingested: row.summaries_ingested,
      latest_summary_ts: row.latest_summary_ts,
      warning_count: row.warning_count ?? 0,
    };
  }

  omxRuntimeWarningsSince(since_ts: number, limit = 10): OmxRuntimeWarningRow[] {
    const rows = this.db
      .prepare(
        `SELECT id,
                task_id,
                session_id,
                ts,
                content,
                json_extract(metadata, '$.warnings') AS warnings,
                json_extract(metadata, '$.quota_warning') AS quota_warning,
                json_extract(metadata, '$.runtime_model_error') AS runtime_model_error,
                json_extract(metadata, '$.last_failed_tool') AS last_failed_tool,
                json_extract(metadata, '$.active_file_focus') AS active_file_focus
         FROM observations
         WHERE kind = 'omx-runtime-summary'
           AND ts > ?
           AND COALESCE(json_extract(metadata, '$.warning_count'), 0) > 0
         ORDER BY ts DESC, id DESC
         LIMIT ?`,
      )
      .all(since_ts, limit) as Array<{
      id: number;
      task_id: number | null;
      session_id: string;
      ts: number;
      content: string;
      warnings: string | null;
      quota_warning: string | null;
      runtime_model_error: string | null;
      last_failed_tool: string | null;
      active_file_focus: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      task_id: row.task_id,
      session_id: row.session_id,
      ts: row.ts,
      content: row.content,
      warnings: parseStringArray(row.warnings),
      quota_warning: row.quota_warning,
      runtime_model_error: row.runtime_model_error,
      last_failed_tool: parseJson(row.last_failed_tool),
      active_file_focus: parseStringArray(row.active_file_focus),
    }));
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
    const trimmed = query.trim();
    if (!trimmed) return [];
    const cap = Math.max(1, limit);
    const candidates: SearchHit[] = [];
    candidates.push(...this.searchFtsMatch(sanitizeMatch(trimmed), cap * 3, filter, 2));

    const terms = searchTerms(trimmed);
    const prefixMatch = prefixMatchQuery(terms);
    if (prefixMatch && prefixMatch !== sanitizeMatch(trimmed)) {
      candidates.push(...this.searchFtsMatch(prefixMatch, cap * 3, filter, 1));
    }

    if (mergeSearchHits(candidates, cap).length < cap) {
      candidates.push(...this.searchFuzzyTerms(terms, cap, filter));
    }

    return mergeSearchHits(candidates, cap);
  }

  private searchFtsMatch(
    match: string,
    limit: number,
    filter: { kind?: string; metadata?: Record<string, string> } | undefined,
    scoreBoost: number,
  ): SearchHit[] {
    if (!match) return [];
    const conditions: string[] = ['observations_fts MATCH ?'];
    const params: Array<string | number> = [match];
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
      score: -r.score + scoreBoost,
      ts: r.ts,
      task_id: r.task_id,
    }));
  }

  private searchFuzzyTerms(
    terms: string[],
    limit: number,
    filter?: { kind?: string; metadata?: Record<string, string> },
  ): SearchHit[] {
    if (terms.length === 0) return [];
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (filter?.kind) {
      conditions.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter?.metadata) {
      for (const [key, value] of Object.entries(filter.metadata)) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) continue;
        conditions.push(`json_extract(metadata, '$.${key}') = ?`);
        params.push(value);
      }
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const scanLimit = Math.max(500, limit * 100);
    const rows = this.db
      .prepare(
        `SELECT id, session_id, kind, content, ts, task_id
         FROM observations
         ${where}
         ORDER BY ts DESC, id DESC
         LIMIT ?`,
      )
      .all(...params, scanLimit) as Array<{
      id: number;
      session_id: string;
      kind: string;
      content: string;
      ts: number;
      task_id: number | null;
    }>;
    return rows
      .map((row) => ({
        row,
        score: fuzzyContentScore(terms, row.content),
      }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || b.row.ts - a.row.ts || b.row.id - a.row.id)
      .slice(0, limit)
      .map(({ row, score }) => ({
        id: row.id,
        session_id: row.session_id,
        kind: row.kind,
        snippet: row.content.slice(0, 160),
        score,
        ts: row.ts,
        task_id: row.task_id,
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
    const vec = new Float32Array(
      new Uint8Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength).slice().buffer,
    );
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

  embeddingsForObservations(
    observationIds: number[],
    filter?: { model: string; dim: number },
  ): Array<{
    observation_id: number;
    vec: Float32Array;
  }> {
    const ids = Array.from(new Set(observationIds.filter((id) => Number.isInteger(id) && id > 0)));
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const conditions = [`observation_id IN (${placeholders})`];
    const params: Array<number | string> = [...ids];
    if (filter) {
      conditions.push('model = ?', 'dim = ?');
      params.push(filter.model, filter.dim);
    }
    const rows = this.db
      .prepare(
        `SELECT observation_id, dim, vec FROM embeddings
         WHERE ${conditions.join(' AND ')}`,
      )
      .all(...params) as Array<{
      observation_id: number;
      dim: number;
      vec: Buffer;
    }>;
    return rows.map((r) => ({
      observation_id: r.observation_id,
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

  observationsMissingEmbeddingsAfter(
    minObservationId: number,
    limit = 100,
    model?: string,
  ): ObservationRow[] {
    if (model) {
      return this.db
        .prepare(
          `SELECT o.* FROM observations o
           LEFT JOIN embeddings e ON e.observation_id = o.id AND e.model = ?
           WHERE o.id > ?
             AND e.observation_id IS NULL
           ORDER BY o.id ASC
           LIMIT ?`,
        )
        .all(model, minObservationId, limit) as ObservationRow[];
    }
    return this.db
      .prepare(
        `SELECT o.* FROM observations o
         LEFT JOIN embeddings e ON e.observation_id = o.id
         WHERE o.id > ?
           AND e.observation_id IS NULL
         ORDER BY o.id ASC
         LIMIT ?`,
      )
      .all(minObservationId, limit) as ObservationRow[];
  }

  lastObservationId(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM observations').get() as {
      id: number;
    };
    return row.id;
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

  recordMcpMetric(metric: NewMcpMetric): void {
    this.db
      .prepare(
        `INSERT INTO mcp_metrics(
          ts, operation, session_id, repo_root, input_bytes, output_bytes, input_tokens, output_tokens, duration_ms, ok, error_code, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        metric.ts,
        metric.operation,
        metric.session_id ?? null,
        metric.repo_root ?? null,
        metric.input_bytes,
        metric.output_bytes,
        metric.input_tokens,
        metric.output_tokens,
        metric.duration_ms,
        metric.ok ? 1 : 0,
        metric.error_code ?? null,
        metric.error_message ?? null,
      );
  }

  aggregateMcpMetrics(opts: AggregateMcpMetricsOptions = {}): McpMetricsAggregate {
    const since = opts.since ?? 0;
    const until = opts.until ?? Date.now();
    const costBasis = normalizeMcpCostBasis(opts.cost);
    const sessionLimit = normalizeMcpSessionLimit(opts.sessionLimit);
    const filters: string[] = ['ts >= ?', 'ts <= ?'];
    const args: Array<number | string> = [since, until];
    if (opts.operation !== undefined) {
      filters.push('operation = ?');
      args.push(opts.operation);
    }
    const where = `WHERE ${filters.join(' AND ')}`;
    const rows = this.db
      .prepare(
        `SELECT operation,
                COUNT(*) AS calls,
                SUM(ok) AS ok_count,
                SUM(CASE WHEN ok = 1 THEN input_tokens + output_tokens ELSE 0 END) AS success_tokens,
                SUM(CASE WHEN ok = 0 THEN input_tokens + output_tokens ELSE 0 END) AS error_tokens,
                MAX(input_tokens) AS max_in_tokens,
                MAX(output_tokens) AS max_out_tokens,
                MAX(input_tokens + output_tokens) AS max_total_tokens,
                MAX(duration_ms) AS max_ms,
                SUM(input_bytes) AS in_bytes,
                SUM(output_bytes) AS out_bytes,
                SUM(input_tokens) AS in_tokens,
                SUM(output_tokens) AS out_tokens,
                SUM(duration_ms) AS total_ms,
                MAX(ts) AS last_ts
           FROM mcp_metrics
           ${where}
          GROUP BY operation
          ORDER BY out_tokens DESC, calls DESC`,
      )
      .all(...args) as McpMetricsOperationRawRow[];
    const errorReasonsByOperation = this.mcpMetricErrorReasonsByOperation(where, args);
    const totalErrorReasons = this.mcpMetricErrorReasons(where, args);
    const totalsRow = this.db
      .prepare(
        `SELECT COUNT(*) AS calls,
                SUM(ok) AS ok_count,
                SUM(CASE WHEN ok = 1 THEN input_tokens + output_tokens ELSE 0 END) AS success_tokens,
                SUM(CASE WHEN ok = 0 THEN input_tokens + output_tokens ELSE 0 END) AS error_tokens,
                MAX(input_tokens) AS max_in_tokens,
                MAX(output_tokens) AS max_out_tokens,
                MAX(input_tokens + output_tokens) AS max_total_tokens,
                MAX(duration_ms) AS max_ms,
                SUM(input_bytes) AS in_bytes,
                SUM(output_bytes) AS out_bytes,
                SUM(input_tokens) AS in_tokens,
                SUM(output_tokens) AS out_tokens,
                SUM(duration_ms) AS total_ms,
                MAX(ts) AS last_ts
           FROM mcp_metrics
           ${where}`,
      )
      .get(...args) as Omit<McpMetricsOperationRawRow, 'operation'> | undefined;
    const operations: McpMetricsAggregateRow[] = rows.map((row) =>
      buildAggregateRow(row, costBasis, errorReasonsByOperation.get(row.operation) ?? []),
    );
    const totals = buildAggregateRow(
      {
        operation: '__total__',
        calls: totalsRow?.calls ?? 0,
        ok_count: totalsRow?.ok_count ?? 0,
        success_tokens: totalsRow?.success_tokens ?? 0,
        error_tokens: totalsRow?.error_tokens ?? 0,
        max_in_tokens: totalsRow?.max_in_tokens ?? 0,
        max_out_tokens: totalsRow?.max_out_tokens ?? 0,
        max_total_tokens: totalsRow?.max_total_tokens ?? 0,
        max_ms: totalsRow?.max_ms ?? 0,
        in_bytes: totalsRow?.in_bytes ?? 0,
        out_bytes: totalsRow?.out_bytes ?? 0,
        in_tokens: totalsRow?.in_tokens ?? 0,
        out_tokens: totalsRow?.out_tokens ?? 0,
        total_ms: totalsRow?.total_ms ?? 0,
        last_ts: totalsRow?.last_ts ?? 0,
      },
      costBasis,
      totalErrorReasons,
    );
    const sessionCount = this.mcpMetricSessionCount(where, args);
    const sessions = this.mcpMetricSessions(where, args, costBasis, sessionLimit);
    return {
      since,
      until,
      ...(opts.operation !== undefined ? { operation: opts.operation } : {}),
      cost_basis: costBasis,
      totals,
      operations,
      session_summary: buildSessionSummary(totals, sessionCount, sessions.length < sessionCount),
      sessions,
    };
  }

  private mcpMetricSessionCount(where: string, args: ReadonlyArray<number | string>): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT COALESCE(NULLIF(session_id, ''), '<unknown>')) AS n
           FROM mcp_metrics
           ${where}`,
      )
      .get(...args) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  private mcpMetricSessions(
    where: string,
    args: ReadonlyArray<number | string>,
    costBasis: McpMetricsCostBasis,
    sessionLimit: number,
  ): McpMetricsSessionAggregateRow[] {
    const limitSql = sessionLimit > 0 ? 'LIMIT ?' : '';
    const queryArgs = sessionLimit > 0 ? [...args, sessionLimit] : args;
    const rows = this.db
      .prepare(
        `SELECT COALESCE(NULLIF(session_id, ''), '<unknown>') AS session_id,
                COUNT(*) AS calls,
                SUM(ok) AS ok_count,
                SUM(input_bytes) AS in_bytes,
                SUM(output_bytes) AS out_bytes,
                SUM(input_tokens) AS in_tokens,
                SUM(output_tokens) AS out_tokens,
                SUM(duration_ms) AS total_ms,
                MAX(ts) AS last_ts
           FROM mcp_metrics
           ${where}
          GROUP BY COALESCE(NULLIF(session_id, ''), '<unknown>')
          ORDER BY out_tokens DESC, calls DESC
          ${limitSql}`,
      )
      .all(...queryArgs) as McpMetricsSessionRawRow[];
    return rows.map((row) => buildSessionAggregateRow(row, costBasis));
  }

  private mcpMetricErrorReasonsByOperation(
    where: string,
    args: ReadonlyArray<number | string>,
  ): Map<string, McpMetricsErrorReason[]> {
    const rows = this.db
      .prepare(
        `SELECT operation,
                error_code,
                error_message,
                COUNT(*) AS count,
                MAX(ts) AS last_ts
           FROM mcp_metrics
           ${where}
            AND ok = 0
          GROUP BY operation, error_code, error_message
          ORDER BY operation ASC, count DESC, last_ts DESC`,
      )
      .all(...args) as McpMetricsErrorReasonRawRow[];
    const byOperation = new Map<string, McpMetricsErrorReason[]>();
    for (const row of rows) {
      const operation = row.operation;
      if (!operation) continue;
      const reasons = byOperation.get(operation) ?? [];
      if (reasons.length >= 3) continue;
      reasons.push(normalizeMcpErrorReason(row));
      byOperation.set(operation, reasons);
    }
    return byOperation;
  }

  private mcpMetricErrorReasons(
    where: string,
    args: ReadonlyArray<number | string>,
  ): McpMetricsErrorReason[] {
    const rows = this.db
      .prepare(
        `SELECT error_code,
                error_message,
                COUNT(*) AS count,
                MAX(ts) AS last_ts
           FROM mcp_metrics
           ${where}
            AND ok = 0
          GROUP BY error_code, error_message
          ORDER BY count DESC, last_ts DESC
          LIMIT 3`,
      )
      .all(...args) as McpMetricsErrorReasonRawRow[];
    return rows.map((row) => normalizeMcpErrorReason(row));
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

  /**
   * Tasks rooted at `repoRoot` whose `branch` is one of `PROTECTED_BRANCH_NAMES`.
   * Backed by the existing `UNIQUE(repo_root, branch)` index on `tasks`.
   * Used by the PreToolUse hook to detect protected-branch claim conflicts
   * without scanning the full task table on every editor tool call.
   */
  listProtectedBranchTasksByRepo(repoRoot: string): TaskRow[] {
    const names = Array.from(PROTECTED_BRANCH_NAMES);
    const placeholders = names.map(() => '?').join(', ');
    return this.db
      .prepare(
        `SELECT * FROM tasks WHERE repo_root = ? AND branch IN (${placeholders}) ORDER BY updated_at DESC`,
      )
      .all(repoRoot, ...names) as TaskRow[];
  }

  touchTask(id: number, ts = Date.now()): void {
    this.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(ts, id);
  }

  /**
   * Mark a queen-plan parent task and every `spec/<slug>/sub-N` row as
   * `status='archived'` in a single transaction. Used by `colony queen
   * archive` and the unblock path for orphan plans whose openspec change
   * directory was never published, so `colony plan close` and
   * `mcp__colony__spec_archive` cannot reach them. Idempotent: archiving
   * an already-archived plan is a no-op (no rows updated, returns 0).
   */
  archiveQueenPlan(args: {
    repo_root: string;
    plan_slug: string;
  }): { parent_task_id: number | null; archived_rows: number } {
    const parentBranch = `spec/${args.plan_slug}`;
    const parent = this.findTaskByBranch(args.repo_root, parentBranch);
    if (!parent) return { parent_task_id: null, archived_rows: 0 };
    const subBranchPrefix = `${parentBranch}/sub-`;
    const ts = Date.now();
    const archived = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE tasks
              SET status = 'archived', updated_at = ?
            WHERE repo_root = ?
              AND status != 'archived'
              AND (id = ? OR branch LIKE ? || '%')`,
        )
        .run(ts, args.repo_root, parent.id, subBranchPrefix);
      return result.changes ?? 0;
    })();
    return { parent_task_id: parent.id, archived_rows: archived };
  }

  /**
   * Count `status='claimed'` sub-task rows for a queen plan. Exposed so
   * `colony queen archive` can refuse without `--force` when an active
   * agent might be relying on the lane.
   */
  countClaimedQueenPlanSubtasks(args: { repo_root: string; plan_slug: string }): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM tasks
          WHERE repo_root = ?
            AND status = 'claimed'
            AND branch LIKE ? || '%'`,
      )
      .get(args.repo_root, `spec/${args.plan_slug}/sub-`) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /**
   * Queen plans whose every `spec/<slug>/sub-N` row has its latest
   * `plan-subtask-claim` observation in `metadata.status='completed'`
   * and whose parent `spec/<slug>` row isn't already `archived`.
   *
   * The MCP plan tool opportunistically archives plans with
   * `auto_archive=true` via a read-path sweep, but plans that never opted
   * in linger as "completed but unarchived" forever. This scan exposes
   * the candidate set so non-MCP callers (CLI, periodic sweep, autopilot)
   * can archive them via `archiveQueenPlan` without requiring per-plan
   * opt-in.
   *
   * Status is derived from observations because `tasks.status` is only
   * ever flipped to `'archived'`; sub-task lifecycle (`available` →
   * `claimed` → `completed`) lives in `plan-subtask-claim` metadata.
   * Excludes plans with zero sub-tasks (incomplete data), plans whose
   * parent row is missing, and plans whose parent is already archived.
   */
  findCompletedQueenPlans(repo_root?: string): Array<{
    plan_slug: string;
    parent_task_id: number;
    repo_root: string;
    subtask_count: number;
  }> {
    const sql = repo_root
      ? `SELECT id, repo_root, branch, status FROM tasks
         WHERE branch LIKE 'spec/%' AND repo_root = ?`
      : `SELECT id, repo_root, branch, status FROM tasks
         WHERE branch LIKE 'spec/%'`;
    const rows = (
      repo_root ? this.db.prepare(sql).all(repo_root) : this.db.prepare(sql).all()
    ) as Array<{ id: number; repo_root: string; branch: string; status: string }>;
    interface PlanGroup {
      repo_root: string;
      plan_slug: string;
      parent_task_id: number | null;
      parent_status: string | null;
      subtask_task_ids: number[];
    }
    const planMap = new Map<string, PlanGroup>();
    const subtaskRe = /^spec\/([a-z0-9][a-z0-9-]*)\/sub-(\d+)$/;
    const parentRe = /^spec\/([a-z0-9][a-z0-9-]*)$/;
    for (const row of rows) {
      const subMatch = subtaskRe.exec(row.branch);
      const parentMatch = parentRe.exec(row.branch);
      const slug = subMatch?.[1] ?? parentMatch?.[1];
      if (!slug) continue;
      const key = `${row.repo_root} ${slug}`;
      let entry = planMap.get(key);
      if (!entry) {
        entry = {
          repo_root: row.repo_root,
          plan_slug: slug,
          parent_task_id: null,
          parent_status: null,
          subtask_task_ids: [],
        };
        planMap.set(key, entry);
      }
      if (parentMatch) {
        entry.parent_task_id = row.id;
        entry.parent_status = row.status;
      } else {
        entry.subtask_task_ids.push(row.id);
      }
    }
    const result: Array<{
      plan_slug: string;
      parent_task_id: number;
      repo_root: string;
      subtask_count: number;
    }> = [];
    for (const entry of planMap.values()) {
      if (entry.parent_task_id === null) continue;
      if (entry.parent_status === 'archived') continue;
      if (entry.subtask_task_ids.length === 0) continue;
      let allCompleted = true;
      for (const subTaskId of entry.subtask_task_ids) {
        const claims = this.taskObservationsByKind(subTaskId, 'plan-subtask-claim', 50);
        const latest = claims[0];
        if (!latest?.metadata) {
          allCompleted = false;
          break;
        }
        let parsed: { status?: unknown };
        try {
          parsed = JSON.parse(latest.metadata) as typeof parsed;
        } catch {
          allCompleted = false;
          break;
        }
        if (parsed.status !== 'completed') {
          allCompleted = false;
          break;
        }
      }
      if (!allCompleted) continue;
      result.push({
        plan_slug: entry.plan_slug,
        parent_task_id: entry.parent_task_id,
        repo_root: entry.repo_root,
        subtask_count: entry.subtask_task_ids.length,
      });
    }
    return result.sort((a, b) => a.plan_slug.localeCompare(b.plan_slug));
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
    const filePath = this.normalizeTaskFilePath(c.task_id, c.file_path);
    if (filePath === null) return;
    // REPLACE semantics: the latest claimer wins. Handoffs atomically swap
    // ownership, so the invariant "at most one owner per (task, file)" is
    // preserved by the transaction, not by the primary key alone.
    this.db
      .prepare(
        `INSERT OR REPLACE INTO task_claims(
          task_id, file_path, session_id, claimed_at, state, expires_at, handoff_observation_id
        ) VALUES (?, ?, ?, ?, 'active', NULL, NULL)`,
      )
      .run(c.task_id, filePath, c.session_id, Date.now());
  }

  markClaimHandoffPending(c: {
    task_id: number;
    file_path: string;
    session_id: string;
    expires_at: number;
    handoff_observation_id: number;
  }): void {
    const filePaths = this.matchingClaimFilePaths(c.task_id, c.file_path);
    if (filePaths.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE task_claims
       SET state = 'handoff_pending',
           expires_at = ?,
           handoff_observation_id = ?
       WHERE task_id = ? AND file_path = ? AND session_id = ? AND state = 'active'`,
    );
    for (const filePath of filePaths) {
      stmt.run(c.expires_at, c.handoff_observation_id, c.task_id, filePath, c.session_id);
    }
  }

  markClaimWeakExpired(c: {
    task_id: number;
    file_path: string;
    session_id: string;
    handoff_observation_id: number;
  }): void {
    const filePaths = this.matchingClaimFilePaths(c.task_id, c.file_path);
    if (filePaths.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE task_claims
       SET state = 'weak_expired'
       WHERE task_id = ?
         AND file_path = ?
         AND session_id = ?
         AND state = 'handoff_pending'
         AND handoff_observation_id = ?`,
    );
    for (const filePath of filePaths) {
      stmt.run(c.task_id, filePath, c.session_id, c.handoff_observation_id);
    }
  }

  /**
   * Bulk-demote `state='active'` claims older than `stale_after_ms` to
   * `state='weak_expired'`. The attention_inbox already surfaces stale
   * claims as a cleanup signal, but until something actually demotes
   * them they keep blocking other agents who treat any 'active' row as
   * live ownership. Pure data update — caller is responsible for
   * emitting `claim-weakened` observations if it wants the demotion to
   * surface in timelines/lane health. Returns the demoted rows so the
   * caller can fan out per-claim observations without a re-read.
   */
  sweepStaleClaims(opts: { stale_after_ms: number; now?: number; limit?: number }): {
    swept: number;
    demoted: TaskClaimRow[];
  } {
    const now = opts.now ?? Date.now();
    const cutoff = now - Math.max(0, opts.stale_after_ms);
    const limit = Math.max(1, opts.limit ?? 1000);
    const candidates = this.db
      .prepare(
        `SELECT * FROM task_claims
         WHERE state = 'active' AND claimed_at < ?
         ORDER BY claimed_at ASC
         LIMIT ?`,
      )
      .all(cutoff, limit) as Partial<TaskClaimRow>[];
    if (candidates.length === 0) return { swept: 0, demoted: [] };
    const stmt = this.db.prepare(
      `UPDATE task_claims
       SET state = 'weak_expired'
       WHERE task_id = ? AND file_path = ? AND session_id = ? AND state = 'active'`,
    );
    const demoted: TaskClaimRow[] = [];
    this.transaction(() => {
      for (const row of candidates) {
        const normalized = this.normalizeTaskClaimRow(row);
        if (!normalized) continue;
        const result = stmt.run(normalized.task_id, normalized.file_path, normalized.session_id);
        if ((result.changes ?? 0) > 0) {
          demoted.push({ ...normalized, state: 'weak_expired' });
        }
      }
    });
    return { swept: demoted.length, demoted };
  }

  releaseClaim(c: { task_id: number; file_path: string; session_id: string }): void {
    const filePaths = this.matchingClaimFilePaths(c.task_id, c.file_path);
    if (filePaths.length === 0) return;
    // Only the current owner can release. Prevents a stale handoff from
    // silently dropping claims another agent already took over.
    const stmt = this.db.prepare(
      'DELETE FROM task_claims WHERE task_id = ? AND file_path = ? AND session_id = ?',
    );
    for (const filePath of filePaths) stmt.run(c.task_id, filePath, c.session_id);
  }

  getClaim(task_id: number, file_path: string): TaskClaimRow | undefined {
    const exact = this.db
      .prepare('SELECT * FROM task_claims WHERE task_id = ? AND file_path = ?')
      .get(task_id, file_path) as Partial<TaskClaimRow> | undefined;
    const normalizedExactRow = this.normalizeTaskClaimRow(exact);
    if (normalizedExactRow) return normalizedExactRow;
    const normalized = this.normalizeTaskFilePath(task_id, file_path);
    if (normalized === null || normalized === file_path) return undefined;
    const normalizedExact = this.db
      .prepare('SELECT * FROM task_claims WHERE task_id = ? AND file_path = ?')
      .get(task_id, normalized) as Partial<TaskClaimRow> | undefined;
    const normalizedClaim = this.normalizeTaskClaimRow(normalizedExact);
    if (normalizedClaim) return normalizedClaim;
    return this.listClaims(task_id).find(
      (claim) => this.normalizeTaskFilePath(task_id, claim.file_path) === normalized,
    );
  }

  listClaims(task_id: number): TaskClaimRow[] {
    const rows = this.db
      .prepare('SELECT * FROM task_claims WHERE task_id = ? ORDER BY claimed_at ASC')
      .all(task_id) as Partial<TaskClaimRow>[];
    return rows.map((row) => this.normalizeTaskClaimRow(row)).filter(isTaskClaimRow);
  }

  private normalizeTaskClaimRow(row: Partial<TaskClaimRow> | undefined): TaskClaimRow | undefined {
    if (!row) return undefined;
    if (
      typeof row.task_id !== 'number' ||
      typeof row.file_path !== 'string' ||
      typeof row.session_id !== 'string' ||
      typeof row.claimed_at !== 'number'
    ) {
      return undefined;
    }
    return {
      task_id: row.task_id,
      file_path: row.file_path,
      session_id: row.session_id,
      claimed_at: row.claimed_at,
      state:
        row.state === 'handoff_pending'
          ? 'handoff_pending'
          : row.state === 'weak_expired'
            ? 'weak_expired'
            : 'active',
      expires_at: row.expires_at ?? null,
      handoff_observation_id: row.handoff_observation_id ?? null,
    };
  }

  normalizeTaskFilePath(task_id: number, file_path: string, cwd?: string): string | null {
    const task = this.getTask(task_id);
    return normalizeClaimPath({
      repo_root: task?.repo_root,
      cwd,
      file_path,
    });
  }

  private matchingClaimFilePaths(task_id: number, file_path: string): string[] {
    const normalized = this.normalizeTaskFilePath(task_id, file_path);
    if (normalized === null) return [];
    const matches = new Set<string>([file_path, normalized]);
    for (const claim of this.listClaims(task_id)) {
      if (this.normalizeTaskFilePath(task_id, claim.file_path) === normalized) {
        matches.add(claim.file_path);
      }
    }
    return [...matches];
  }

  /**
   * Claims made in the last `since_ts…now` window. Used by the conflict
   * preface to surface "someone else is ACTIVELY editing this" — stale
   * claims (outside the window) are intentionally excluded because they
   * describe work that's already finished, not live collisions.
   */
  recentClaims(task_id: number, since_ts: number, limit = 50): TaskClaimRow[] {
    const activeClaimPredicate = this.taskClaimColumns.has('state') ? "AND state = 'active'" : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM task_claims
         WHERE task_id = ? AND claimed_at > ? ${activeClaimPredicate}
         ORDER BY claimed_at DESC LIMIT ?`,
      )
      .all(task_id, since_ts, limit) as Partial<TaskClaimRow>[];
    return rows.map((row) => this.normalizeTaskClaimRow(row)).filter(isTaskClaimRow);
  }

  // --- account claims ---
  // Planner-side dispatch bindings (which Codex account a wave is bound to).
  // Lifecycle is intentionally simpler than task_claims: only `active` and
  // `released` states, no handoff baton — when an operator unbinds the wave
  // the active row is flipped to `released` and a new active row may then
  // take its place. The partial unique index on (plan_slug, wave_id) WHERE
  // state='active' enforces the at-most-one-active invariant.

  claimAccount(c: NewAccountClaim & { claimed_at?: number }): AccountClaimRow {
    const now = c.claimed_at ?? Date.now();
    return this.transaction(() => {
      const existing = this.getActiveAccountClaim(c.plan_slug, c.wave_id);
      if (existing) {
        // If the same account is already bound, refresh the row in place.
        // Otherwise release the prior binding before inserting the new one,
        // so the partial unique index never trips.
        if (
          existing.account_id === c.account_id &&
          existing.session_id === (c.session_id ?? null)
        ) {
          this.db
            .prepare(
              `UPDATE account_claims
               SET claimed_at = ?, expires_at = ?, note = ?
               WHERE id = ?`,
            )
            .run(now, c.expires_at ?? null, c.note ?? null, existing.id);
          const refreshed = this.getAccountClaimById(existing.id);
          if (!refreshed) {
            throw new Error(`account_claims row ${existing.id} vanished after refresh`);
          }
          return refreshed;
        }
        this.db
          .prepare(
            `UPDATE account_claims
             SET state = 'released',
                 released_at = ?,
                 released_by_session_id = ?
             WHERE id = ?`,
          )
          .run(now, c.session_id ?? null, existing.id);
      }
      const result = this.db
        .prepare(
          `INSERT INTO account_claims(
            plan_slug, wave_id, account_id, session_id, agent,
            claimed_at, state, expires_at, note
          ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          c.plan_slug,
          c.wave_id,
          c.account_id,
          c.session_id ?? null,
          c.agent ?? null,
          now,
          c.expires_at ?? null,
          c.note ?? null,
        );
      const id = Number(result.lastInsertRowid);
      const inserted = this.getAccountClaimById(id);
      if (!inserted) {
        throw new Error(`account_claims insert ${id} did not surface`);
      }
      return inserted;
    });
  }

  releaseAccountClaim(c: {
    id: number;
    released_by_session_id?: string | null;
    released_at?: number;
  }): AccountClaimRow | undefined {
    const now = c.released_at ?? Date.now();
    this.db
      .prepare(
        `UPDATE account_claims
         SET state = 'released',
             released_at = ?,
             released_by_session_id = ?
         WHERE id = ? AND state = 'active'`,
      )
      .run(now, c.released_by_session_id ?? null, c.id);
    return this.getAccountClaimById(c.id);
  }

  getAccountClaimById(id: number): AccountClaimRow | undefined {
    const row = this.db.prepare('SELECT * FROM account_claims WHERE id = ?').get(id) as
      | Partial<AccountClaimRow>
      | undefined;
    return this.normalizeAccountClaimRow(row);
  }

  getActiveAccountClaim(plan_slug: string, wave_id: string): AccountClaimRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM account_claims
         WHERE plan_slug = ? AND wave_id = ? AND state = 'active'
         LIMIT 1`,
      )
      .get(plan_slug, wave_id) as Partial<AccountClaimRow> | undefined;
    return this.normalizeAccountClaimRow(row);
  }

  listAccountClaims(
    opts: {
      plan_slug?: string;
      account_id?: string;
      state?: AccountClaimState;
      limit?: number;
    } = {},
  ): AccountClaimRow[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (opts.plan_slug) {
      clauses.push('plan_slug = ?');
      params.push(opts.plan_slug);
    }
    if (opts.account_id) {
      clauses.push('account_id = ?');
      params.push(opts.account_id);
    }
    if (opts.state) {
      clauses.push('state = ?');
      params.push(opts.state);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, opts.limit ?? 200);
    params.push(limit);
    const rows = this.db
      .prepare(`SELECT * FROM account_claims ${where} ORDER BY claimed_at DESC LIMIT ?`)
      .all(...params) as Partial<AccountClaimRow>[];
    return rows
      .map((row) => this.normalizeAccountClaimRow(row))
      .filter((row): row is AccountClaimRow => row !== undefined);
  }

  private normalizeAccountClaimRow(
    row: Partial<AccountClaimRow> | undefined,
  ): AccountClaimRow | undefined {
    if (!row) return undefined;
    if (
      typeof row.id !== 'number' ||
      typeof row.plan_slug !== 'string' ||
      typeof row.wave_id !== 'string' ||
      typeof row.account_id !== 'string' ||
      typeof row.claimed_at !== 'number'
    ) {
      return undefined;
    }
    return {
      id: row.id,
      plan_slug: row.plan_slug,
      wave_id: row.wave_id,
      account_id: row.account_id,
      session_id: row.session_id ?? null,
      agent: row.agent ?? null,
      claimed_at: row.claimed_at,
      state: row.state === 'released' ? 'released' : 'active',
      expires_at: row.expires_at ?? null,
      released_at: row.released_at ?? null,
      released_by_session_id: row.released_by_session_id ?? null,
      note: row.note ?? null,
    };
  }

  setLaneState(p: {
    session_id: string;
    state: LaneRunState;
    updated_by_session_id: string;
    reason?: string | null;
    updated_at?: number;
  }): LaneStateRow {
    const now = p.updated_at ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO lane_states(session_id, state, reason, updated_at, updated_by_session_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           state = excluded.state,
           reason = excluded.reason,
           updated_at = excluded.updated_at,
           updated_by_session_id = excluded.updated_by_session_id`,
      )
      .run(p.session_id, p.state, p.reason ?? null, now, p.updated_by_session_id);
    return this.getLaneState(p.session_id) as LaneStateRow;
  }

  getLaneState(session_id: string): LaneStateRow | undefined {
    return this.db.prepare('SELECT * FROM lane_states WHERE session_id = ?').get(session_id) as
      | LaneStateRow
      | undefined;
  }

  listPausedLanes(limit = 100): PausedLaneRow[] {
    return this.db
      .prepare(
        `SELECT ls.session_id,
                ls.state,
                ls.reason,
                ls.updated_at,
                ls.updated_by_session_id,
                s.ide,
                s.cwd,
                (
                  SELECT t.id
                  FROM task_participants p
                  JOIN tasks t ON t.id = p.task_id
                  WHERE p.session_id = ls.session_id
                    AND p.left_at IS NULL
                  ORDER BY t.updated_at DESC, p.joined_at DESC
                  LIMIT 1
                ) AS task_id,
                (
                  SELECT t.repo_root
                  FROM task_participants p
                  JOIN tasks t ON t.id = p.task_id
                  WHERE p.session_id = ls.session_id
                    AND p.left_at IS NULL
                  ORDER BY t.updated_at DESC, p.joined_at DESC
                  LIMIT 1
                ) AS repo_root,
                (
                  SELECT t.branch
                  FROM task_participants p
                  JOIN tasks t ON t.id = p.task_id
                  WHERE p.session_id = ls.session_id
                    AND p.left_at IS NULL
                  ORDER BY t.updated_at DESC, p.joined_at DESC
                  LIMIT 1
                ) AS branch,
                (
                  SELECT t.title
                  FROM task_participants p
                  JOIN tasks t ON t.id = p.task_id
                  WHERE p.session_id = ls.session_id
                    AND p.left_at IS NULL
                  ORDER BY t.updated_at DESC, p.joined_at DESC
                  LIMIT 1
                ) AS task_title
         FROM lane_states ls
         LEFT JOIN sessions s ON s.id = ls.session_id
         WHERE ls.state = 'paused'
         ORDER BY ls.updated_at DESC, ls.session_id ASC
         LIMIT ?`,
      )
      .all(limit) as PausedLaneRow[];
  }

  findClaimBySessionAndFile(session_id: string, file_path: string): TaskClaimRow | undefined {
    return this.normalizeTaskClaimRow(
      this.db
        .prepare(
          `SELECT *
           FROM task_claims
           WHERE session_id = ?
             AND file_path = ?
           ORDER BY claimed_at DESC
           LIMIT 1`,
        )
        .get(session_id, file_path) as Partial<TaskClaimRow> | undefined,
    );
  }

  takeOverLaneClaim(p: {
    target_session_id: string;
    requester_session_id: string;
    file_path: string;
    reason: string;
    requester_agent?: string | null;
    now?: number;
  }): LaneTakeoverResult {
    const now = p.now ?? Date.now();
    const previous = this.findClaimBySessionAndFile(p.target_session_id, p.file_path);
    if (!previous) {
      throw new Error(`no claim for ${p.file_path} held by ${p.target_session_id}`);
    }
    return this.transaction(() => {
      this.createSession({
        id: p.requester_session_id,
        ide: p.requester_agent ?? 'unknown',
        cwd: null,
        started_at: now,
        metadata: null,
      });
      this.db
        .prepare(
          `INSERT OR REPLACE INTO task_claims(
            task_id, file_path, session_id, claimed_at, state, expires_at, handoff_observation_id
          ) VALUES (?, ?, ?, ?, 'active', NULL, NULL)`,
        )
        .run(previous.task_id, previous.file_path, p.requester_session_id, now);
      const weakenedObservationId = this.insertObservation({
        session_id: previous.session_id,
        kind: 'claim-weakened',
        content: `claim ${previous.file_path} weakened by takeover from ${p.requester_session_id}: ${p.reason}`,
        compressed: false,
        intensity: null,
        ts: now,
        task_id: previous.task_id,
        metadata: {
          kind: 'claim-weakened',
          file_path: previous.file_path,
          previous_session_id: previous.session_id,
          assigned_session_id: p.requester_session_id,
          reason: p.reason,
          ownership_strength: 'weak',
          previous_claimed_at: previous.claimed_at,
        },
      });
      const takeoverObservationId = this.insertObservation({
        session_id: p.requester_session_id,
        kind: 'lane-takeover',
        content: `takeover ${previous.file_path} from ${previous.session_id}: ${p.reason}`,
        compressed: false,
        intensity: null,
        ts: now,
        task_id: previous.task_id,
        metadata: {
          kind: 'lane-takeover',
          target_session_id: previous.session_id,
          assigned_session_id: p.requester_session_id,
          file_path: previous.file_path,
          reason: p.reason,
          weakened_observation_id: weakenedObservationId,
          previous_claimed_at: previous.claimed_at,
        },
      });
      this.touchTask(previous.task_id, now);
      return {
        task_id: previous.task_id,
        file_path: previous.file_path,
        previous_session_id: previous.session_id,
        assigned_session_id: p.requester_session_id,
        previous_claimed_at: previous.claimed_at,
        weakened_observation_id: weakenedObservationId,
        takeover_observation_id: takeoverObservationId,
      };
    });
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
      .prepare(
        'SELECT * FROM observations WHERE task_id = ? AND kind = ? ORDER BY ts DESC, id DESC LIMIT ?',
      )
      .all(task_id, kind, limit) as ObservationRow[];
  }

  taskTimeline(task_id: number, limit = 50): ObservationRow[] {
    return this.db
      .prepare('SELECT * FROM observations WHERE task_id = ? ORDER BY ts DESC, id DESC LIMIT ?')
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

  /**
   * Run a function inside a SQLite transaction. All-or-nothing.
   *
   * Pass `{ immediate: true }` to use BEGIN IMMEDIATE instead of the default
   * BEGIN DEFERRED. IMMEDIATE acquires the write lock at transaction start,
   * which prevents read-then-write races when two callers both read the same
   * rows and then try to modify them (e.g. claim cleanup loops running in
   * parallel processes).
   */
  transaction<T>(fn: () => T, options?: { immediate?: boolean }): T {
    const txFn = this.db.transaction(fn);
    return options?.immediate ? txFn.immediate() : txFn();
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
    const edits = this.db
      .prepare(
        `SELECT o.session_id,
                json_extract(o.metadata, '$.file_path') AS file_path,
                o.ts,
                o.task_id
         FROM observations o
         WHERE o.kind = 'tool_use'
           AND o.ts > ?
           AND json_extract(o.metadata, '$.file_path') IS NOT NULL
         ORDER BY o.ts DESC
         LIMIT ?`,
      )
      .all(since_ts, Math.max(limit * 5, limit)) as Array<{
      session_id: string;
      file_path: string;
      ts: number;
      task_id: number | null;
    }>;
    const claims = this.claimObservations();
    const rows: Array<{
      session_id: string;
      file_path: string;
      ts: number;
      task_id: number | null;
    }> = [];
    for (const edit of edits) {
      const normalized = this.normalizedObservationFilePath(edit);
      if (normalized === null) continue;
      if (this.hasMatchingClaimBeforeEdit(claims, { ...edit, file_path: normalized })) continue;
      rows.push({ ...edit, file_path: normalized });
      if (rows.length >= limit) break;
    }
    return rows;
  }

  private claimObservations(): Array<{
    session_id: string;
    file_path: string | null;
    ts: number;
    task_id: number | null;
  }> {
    return this.db
      .prepare(
        `SELECT session_id,
                json_extract(metadata, '$.file_path') AS file_path,
                ts,
                task_id
         FROM observations
         WHERE kind = 'claim'
           AND json_extract(metadata, '$.file_path') IS NOT NULL
         ORDER BY ts ASC`,
      )
      .all() as Array<{
      session_id: string;
      file_path: string | null;
      ts: number;
      task_id: number | null;
    }>;
  }

  private normalizedObservationFilePath(row: {
    task_id: number | null;
    file_path: string | null;
  }): string | null {
    if (row.file_path === null) return null;
    const task = row.task_id === null ? undefined : this.getTask(row.task_id);
    return normalizeClaimPath({
      repo_root: task?.repo_root,
      cwd: task?.repo_root,
      file_path: row.file_path,
    });
  }

  private hasMatchingClaimBeforeEdit(
    claims: Array<{
      session_id: string;
      file_path: string | null;
      ts: number;
      task_id: number | null;
    }>,
    edit: { session_id: string; file_path: string; ts: number; task_id: number | null },
  ): boolean {
    return claims.some((claim) => {
      if (claim.ts > edit.ts) return false;
      if (claim.session_id !== edit.session_id) return false;
      if (claim.task_id !== null && edit.task_id !== null && claim.task_id !== edit.task_id) {
        return false;
      }
      return this.normalizedObservationFilePath(claim) === edit.file_path;
    });
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
    const editRows = this.db
      .prepare(
        `WITH edit_tools(tool) AS (
           SELECT value AS tool FROM json_each(?)
         )
         SELECT o.id,
                o.session_id,
                o.ts,
                json_extract(o.metadata, '$.file_path') AS file_path,
                COALESCE(
                  json_extract(o.metadata, '$.repo_root'),
                  json_extract(o.metadata, '$.repoRoot'),
                  json_extract(s.metadata, '$.repo_root'),
                  json_extract(s.metadata, '$.repoRoot'),
                  (
                    SELECT t.repo_root
                    FROM task_participants p
                    JOIN tasks t ON t.id = p.task_id
                    WHERE p.session_id = o.session_id
                      AND p.left_at IS NULL
                    ORDER BY t.updated_at DESC, p.joined_at DESC
                    LIMIT 1
                  )
                ) AS repo_root,
                COALESCE(
                  json_extract(o.metadata, '$.branch'),
                  json_extract(s.metadata, '$.branch'),
                  (
                    SELECT t.branch
                    FROM task_participants p
                    JOIN tasks t ON t.id = p.task_id
                    WHERE p.session_id = o.session_id
                      AND p.left_at IS NULL
                    ORDER BY t.updated_at DESC, p.joined_at DESC
                    LIMIT 1
                  )
                ) AS branch,
                COALESCE(
                  json_extract(o.metadata, '$.worktree_path'),
                  json_extract(o.metadata, '$.worktreePath'),
                  json_extract(o.metadata, '$.cwd'),
                  json_extract(s.metadata, '$.worktree_path'),
                  json_extract(s.metadata, '$.worktreePath'),
                  json_extract(s.metadata, '$.cwd'),
                  s.cwd
                ) AS worktree_path,
                COALESCE(
                  json_extract(o.metadata, '$.inferred_agent'),
                  json_extract(o.metadata, '$.agent'),
                  json_extract(s.metadata, '$.inferred_agent'),
                  json_extract(s.metadata, '$.agent'),
                  (
                    SELECT p.agent
                    FROM task_participants p
                    JOIN tasks t ON t.id = p.task_id
                    WHERE p.session_id = o.session_id
                      AND p.left_at IS NULL
                    ORDER BY t.updated_at DESC, p.joined_at DESC
                    LIMIT 1
                  ),
                  s.ide,
                  o.session_id
                ) AS agent_identity
         FROM observations o
         LEFT JOIN sessions s ON s.id = o.session_id
         JOIN edit_tools et
           ON et.tool = COALESCE(
             json_extract(o.metadata, '$.tool'),
             json_extract(o.metadata, '$.tool_name')
           )
         WHERE o.ts > ?
           AND o.kind = 'tool_use'
         ORDER BY o.ts ASC, o.id ASC`,
      )
      .all(FILE_EDIT_TOOLS_JSON, since_ts) as ClaimBeforeEditRow[];
    const claimRows = this.db
      .prepare(
        `SELECT c.id,
                c.session_id,
                c.ts,
                json_extract(c.metadata, '$.file_path') AS file_path,
                COALESCE(
                  json_extract(c.metadata, '$.repo_root'),
                  json_extract(c.metadata, '$.repoRoot'),
                  t.repo_root,
                  json_extract(s.metadata, '$.repo_root'),
                  json_extract(s.metadata, '$.repoRoot')
                ) AS repo_root,
                COALESCE(
                  json_extract(c.metadata, '$.branch'),
                  t.branch,
                  json_extract(s.metadata, '$.branch')
                ) AS branch,
                COALESCE(
                  json_extract(c.metadata, '$.worktree_path'),
                  json_extract(c.metadata, '$.worktreePath'),
                  json_extract(c.metadata, '$.cwd'),
                  json_extract(s.metadata, '$.worktree_path'),
                  json_extract(s.metadata, '$.worktreePath'),
                  json_extract(s.metadata, '$.cwd'),
                  s.cwd
                ) AS worktree_path,
                COALESCE(
                  json_extract(c.metadata, '$.inferred_agent'),
                  json_extract(c.metadata, '$.agent'),
                  json_extract(s.metadata, '$.inferred_agent'),
                  json_extract(s.metadata, '$.agent'),
                  p.agent,
                  s.ide,
                  c.session_id
                ) AS agent_identity
         FROM observations c
         LEFT JOIN sessions s ON s.id = c.session_id
         LEFT JOIN tasks t ON t.id = c.task_id
         LEFT JOIN task_participants p
           ON p.task_id = c.task_id
          AND p.session_id = c.session_id
          AND p.left_at IS NULL
         WHERE c.kind = 'claim'
           AND json_extract(c.metadata, '$.file_path') IS NOT NULL
         ORDER BY c.ts ASC, c.id ASC`,
      )
      .all() as ClaimBeforeEditRow[];
    const telemetry = this.db
      .prepare(
        `SELECT
           SUM(CASE
             WHEN kind = 'claim'
              AND json_extract(metadata, '$.source') = 'pre-tool-use'
              AND json_extract(metadata, '$.auto_claimed_before_edit') = 1
             THEN 1 ELSE 0
           END) AS auto_claimed_before_edit,
           SUM(CASE
             WHEN kind = 'claim-before-edit'
              AND json_extract(metadata, '$.session_binding_missing') = 1
             THEN 1 ELSE 0
           END) AS session_binding_missing,
           SUM(CASE WHEN kind = 'claim-before-edit' THEN 1 ELSE 0 END) AS pre_tool_use_signals
         FROM observations
         WHERE ts > ?
           AND kind IN ('claim', 'claim-before-edit')`,
      )
      .get(since_ts) as {
      auto_claimed_before_edit: number | null;
      session_binding_missing: number | null;
      pre_tool_use_signals: number | null;
    };
    const signalRows = this.db
      .prepare(
        `SELECT c.id,
                COALESCE(json_extract(c.metadata, '$.original_session_id'), c.session_id) AS session_id,
                c.ts,
                json_extract(c.metadata, '$.file_path') AS file_path,
                COALESCE(
                  json_extract(c.metadata, '$.repo_root'),
                  json_extract(c.metadata, '$.repoRoot'),
                  t.repo_root,
                  json_extract(s.metadata, '$.repo_root'),
                  json_extract(s.metadata, '$.repoRoot')
                ) AS repo_root,
                COALESCE(
                  json_extract(c.metadata, '$.branch'),
                  t.branch,
                  json_extract(s.metadata, '$.branch')
                ) AS branch,
                COALESCE(
                  json_extract(c.metadata, '$.worktree_path'),
                  json_extract(c.metadata, '$.worktreePath'),
                  json_extract(c.metadata, '$.cwd'),
                  json_extract(s.metadata, '$.worktree_path'),
                  json_extract(s.metadata, '$.worktreePath'),
                  json_extract(s.metadata, '$.cwd'),
                  s.cwd
                ) AS worktree_path,
                COALESCE(
                  json_extract(c.metadata, '$.inferred_agent'),
                  json_extract(c.metadata, '$.agent'),
                  json_extract(s.metadata, '$.inferred_agent'),
                  json_extract(s.metadata, '$.agent'),
                  p.agent,
                  s.ide,
                  c.session_id
                ) AS agent_identity
         FROM observations c
         LEFT JOIN sessions s ON s.id = c.session_id
         LEFT JOIN tasks t ON t.id = c.task_id
         LEFT JOIN task_participants p
           ON p.task_id = c.task_id
          AND p.session_id = c.session_id
          AND p.left_at IS NULL
         WHERE c.ts > ?
           AND c.kind = 'claim-before-edit'
         ORDER BY c.ts ASC, c.id ASC`,
      )
      .all(since_ts) as ClaimBeforeEditRow[];
    const correlation = claimBeforeEditCorrelation(
      editRows,
      claimRows,
      signalRows,
      DEFAULT_CLAIM_WINDOW_MS,
    );
    return {
      edit_tool_calls: editRows.length,
      edits_with_file_path: editRows.filter((row) => row.file_path !== null).length,
      edits_claimed_before: correlation.edits_claimed_before,
      claim_match_window_ms: DEFAULT_CLAIM_WINDOW_MS,
      claim_match_sources: correlation.claim_match_sources,
      claim_miss_reasons: correlation.claim_miss_reasons,
      nearest_claim_examples: correlation.nearest_claim_examples,
      auto_claimed_before_edit: telemetry.auto_claimed_before_edit ?? 0,
      session_binding_missing: telemetry.session_binding_missing ?? 0,
      pre_tool_use_signals: telemetry.pre_tool_use_signals ?? 0,
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

function emptyClaimMatchSources(): ClaimMatchSources {
  return {
    exact_session: 0,
    repo_branch: 0,
    worktree: 0,
    agent_lane: 0,
  };
}

function emptyClaimMissReasons(): ClaimMissReasons {
  return {
    no_claim_for_file: 0,
    claim_after_edit: 0,
    session_id_mismatch: 0,
    repo_root_mismatch: 0,
    branch_mismatch: 0,
    path_mismatch: 0,
    worktree_path_mismatch: 0,
    pseudo_path_skipped: 0,
    pre_tool_use_missing: 0,
  };
}

export type ClaimBeforeEditMatchSource = keyof ClaimMatchSources;
export type ClaimBeforeEditMatchSources = ClaimMatchSources;
type ClaimMissReason = keyof ClaimMissReasons;

function claimBeforeEditCorrelation(
  editRows: ClaimBeforeEditRow[],
  claimRows: ClaimBeforeEditRow[],
  signalRows: ClaimBeforeEditRow[],
  claimWindowMs: number,
): {
  edits_claimed_before: number;
  claim_match_sources: ClaimMatchSources;
  claim_miss_reasons: ClaimMissReasons;
  nearest_claim_examples: NearestClaimExample[];
} {
  const matchSources = emptyClaimMatchSources();
  const missReasons = emptyClaimMissReasons();
  const nearestClaimExamples: NearestClaimExample[] = [];
  let editsClaimedBefore = 0;
  for (const edit of editRows) {
    if (edit.file_path === null) continue;
    if (isPseudoClaimPath(edit.file_path)) {
      missReasons.pseudo_path_skipped++;
      pushNearestClaimExample(nearestClaimExamples, 'pseudo_path_skipped', edit, claimRows);
      continue;
    }
    const sameFileClaims = claimRows.filter(
      (claim) => claim.file_path !== null && sameComparableFilePath(edit, claim),
    );
    const priorSameFileClaims = sameFileClaims.filter((claim) =>
      isPriorClaimWithinWindow(edit, claim, claimWindowMs),
    );
    const matchSource = claimBeforeEditMatchSource(edit, priorSameFileClaims);
    if (!matchSource) continue;
    editsClaimedBefore++;
    matchSources[matchSource]++;
  }
  for (const edit of editRows) {
    if (edit.file_path === null) continue;
    if (isPseudoClaimPath(edit.file_path)) continue;
    const sameFileClaims = claimRows.filter(
      (claim) => claim.file_path !== null && sameComparableFilePath(edit, claim),
    );
    const priorSameFileClaims = sameFileClaims.filter((claim) =>
      isPriorClaimWithinWindow(edit, claim, claimWindowMs),
    );
    if (claimBeforeEditMatchSource(edit, priorSameFileClaims)) continue;
    const outcome = claimMissOutcome(edit, claimRows, signalRows, claimWindowMs);
    missReasons[outcome.reason]++;
    pushNearestClaimExample(
      nearestClaimExamples,
      outcome.reason,
      edit,
      claimRows,
      outcome.triggering_claim,
    );
  }
  return {
    edits_claimed_before: editsClaimedBefore,
    claim_match_sources: matchSources,
    claim_miss_reasons: missReasons,
    nearest_claim_examples: nearestClaimExamples,
  };
}

function claimBeforeEditMatchSource(
  edit: ClaimBeforeEditRow,
  priorSameFileClaims: ClaimBeforeEditRow[],
): ClaimBeforeEditMatchSource | null {
  if (
    priorSameFileClaims.some(
      (claim) => claim.session_id === edit.session_id && compatibleClaimScope(edit, claim),
    )
  ) {
    return 'exact_session';
  }
  if (priorSameFileClaims.some((claim) => sameRepoBranch(edit, claim))) return 'repo_branch';
  if (priorSameFileClaims.some((claim) => sameWorktree(edit, claim))) return 'worktree';
  if (hasUnambiguousAgentLaneMatch(edit, priorSameFileClaims)) return 'agent_lane';
  return null;
}

function isPriorClaimWithinWindow(
  edit: ClaimBeforeEditRow,
  claim: ClaimBeforeEditRow,
  claimWindowMs: number,
): boolean {
  return claim.ts <= edit.ts && claim.ts >= edit.ts - claimWindowMs;
}

function sameRepoBranch(edit: ClaimBeforeEditRow, claim: ClaimBeforeEditRow): boolean {
  return (
    normalizeRoot(edit.repo_root) !== null &&
    normalizeRoot(edit.repo_root) === normalizeRoot(claim.repo_root) &&
    edit.branch !== null &&
    edit.branch === claim.branch
  );
}

function sameWorktree(edit: ClaimBeforeEditRow, claim: ClaimBeforeEditRow): boolean {
  return (
    normalizeRoot(edit.worktree_path) !== null &&
    normalizeRoot(edit.worktree_path) === normalizeRoot(claim.worktree_path) &&
    compatibleClaimScope(edit, claim)
  );
}

function hasUnambiguousAgentLaneMatch(
  edit: ClaimBeforeEditRow,
  claims: ClaimBeforeEditRow[],
): boolean {
  const matches = claims.filter(
    (claim) => sameAgentIdentity(edit, claim) && sameRepoBranch(edit, claim),
  );
  if (matches.length === 0) return false;
  return new Set(matches.map((claim) => claim.session_id)).size === 1;
}

type ClaimMissOutcome = {
  reason: ClaimMissReason;
  /**
   * The claim row that actually drove the bucket assignment, if any. The
   * report previously surfaced the closest-by-rank claim, which for a
   * `path_mismatch` could be a same-file claim 4+ days old (outside the
   * 5-minute window) and contradicted the bucket label. Carrying the
   * triggering claim through lets the report show the real culprit.
   */
  triggering_claim: ClaimBeforeEditRow | null;
};

function claimMissOutcome(
  edit: ClaimBeforeEditRow,
  claimRows: ClaimBeforeEditRow[],
  signalRows: ClaimBeforeEditRow[],
  claimWindowMs: number,
): ClaimMissOutcome {
  const sameFileClaims = claimRows
    .filter((claim) => claim.file_path !== null && sameComparableFilePath(edit, claim))
    .sort((a, b) => claimDistance(edit, a) - claimDistance(edit, b) || a.id - b.id);

  const afterEditSameFile = sameFileClaims.find(
    (claim) => claim.ts > edit.ts && claimDistance(edit, claim) <= claimWindowMs,
  );
  if (afterEditSameFile) {
    return { reason: 'claim_after_edit', triggering_claim: afterEditSameFile };
  }

  const priorSameFileClaims = sameFileClaims.filter((claim) =>
    isPriorClaimWithinWindow(edit, claim, claimWindowMs),
  );
  const nearestPriorSameFile = priorSameFileClaims[0];
  if (nearestPriorSameFile) {
    if (knownRootMismatch(edit.repo_root, nearestPriorSameFile.repo_root)) {
      return { reason: 'repo_root_mismatch', triggering_claim: nearestPriorSameFile };
    }
    if (knownValueMismatch(edit.branch, nearestPriorSameFile.branch)) {
      return { reason: 'branch_mismatch', triggering_claim: nearestPriorSameFile };
    }
    if (knownRootMismatch(edit.worktree_path, nearestPriorSameFile.worktree_path)) {
      return { reason: 'worktree_path_mismatch', triggering_claim: nearestPriorSameFile };
    }
    if (nearestPriorSameFile.session_id !== edit.session_id) {
      return { reason: 'session_id_mismatch', triggering_claim: nearestPriorSameFile };
    }
  }

  const pathMismatchTrigger = claimRows
    .filter(
      (claim) =>
        claim.ts <= edit.ts &&
        claimDistance(edit, claim) <= claimWindowMs &&
        !sameComparableFilePath(edit, claim) &&
        sameClaimLaneOrSession(edit, claim),
    )
    .sort((a, b) => claimDistance(edit, a) - claimDistance(edit, b) || a.id - b.id)[0];
  if (pathMismatchTrigger) {
    return { reason: 'path_mismatch', triggering_claim: pathMismatchTrigger };
  }

  if (!hasRelatedPreToolUseSignal(edit, signalRows, claimWindowMs)) {
    return { reason: 'pre_tool_use_missing', triggering_claim: null };
  }

  return { reason: 'no_claim_for_file', triggering_claim: null };
}

function pushNearestClaimExample(
  examples: NearestClaimExample[],
  reason: ClaimMissReason,
  edit: ClaimBeforeEditRow,
  claimRows: ClaimBeforeEditRow[],
  triggeringClaim: ClaimBeforeEditRow | null = null,
): void {
  if (examples.length >= DEFAULT_NEAREST_CLAIM_EXAMPLE_LIMIT) return;
  const nearest = triggeringClaim ?? nearestClaimCandidate(edit, claimRows);
  examples.push(toNearestClaimExample(reason, edit, nearest));
}

function nearestClaimCandidate(
  edit: ClaimBeforeEditRow,
  claimRows: ClaimBeforeEditRow[],
): ClaimBeforeEditRow | null {
  const ranked = claimRows
    .map((claim) => ({
      claim,
      rank: claimCandidateRank(edit, claim),
      distance: claimDistance(edit, claim),
    }))
    .sort((a, b) => a.rank - b.rank || a.distance - b.distance || a.claim.id - b.claim.id);
  return ranked[0]?.claim ?? null;
}

function claimCandidateRank(edit: ClaimBeforeEditRow, claim: ClaimBeforeEditRow): number {
  if (claim.file_path !== null && sameComparableFilePath(edit, claim)) return 0;
  if (claim.session_id === edit.session_id) return 10;
  if (sameRepoBranch(edit, claim)) return 20;
  if (sameWorktree(edit, claim)) return 30;
  return 100;
}

function claimDistance(edit: ClaimBeforeEditRow, claim: ClaimBeforeEditRow): number {
  return Math.abs(edit.ts - claim.ts);
}

function toNearestClaimExample(
  reason: ClaimMissReason,
  edit: ClaimBeforeEditRow,
  claim: ClaimBeforeEditRow | null,
): NearestClaimExample {
  return {
    reason,
    edit_id: edit.id,
    edit_session_id: edit.session_id,
    edit_file_path: edit.file_path,
    edit_repo_root: edit.repo_root,
    edit_branch: edit.branch,
    edit_worktree_path: edit.worktree_path,
    edit_ts: edit.ts,
    nearest_claim_id: claim?.id ?? null,
    claim_session_id: claim?.session_id ?? null,
    claim_file_path: claim?.file_path ?? null,
    claim_repo_root: claim?.repo_root ?? null,
    claim_branch: claim?.branch ?? null,
    claim_worktree_path: claim?.worktree_path ?? null,
    claim_ts: claim?.ts ?? null,
    distance_ms: claim ? claimDistance(edit, claim) : null,
    relation: {
      same_file_path: claim ? sameComparableFilePath(edit, claim) : false,
      same_session_id: claim ? claim.session_id === edit.session_id : false,
      same_repo_root: claim ? nullableSameRoot(edit.repo_root, claim.repo_root) : null,
      same_branch: claim ? nullableSameValue(edit.branch, claim.branch) : null,
      same_worktree_path: claim ? nullableSameRoot(edit.worktree_path, claim.worktree_path) : null,
      claim_before_edit: claim ? claim.ts <= edit.ts : null,
    },
  };
}

function hasRelatedPreToolUseSignal(
  edit: ClaimBeforeEditRow,
  signalRows: ClaimBeforeEditRow[],
  claimWindowMs: number,
): boolean {
  return signalRows.some(
    (signal) =>
      claimDistance(edit, signal) <= claimWindowMs &&
      (signal.session_id === edit.session_id ||
        sameRepoBranch(edit, signal) ||
        sameWorktree(edit, signal)) &&
      (signal.file_path === null || sameComparableFilePath(edit, signal)),
  );
}

function sameClaimLaneOrSession(edit: ClaimBeforeEditRow, claim: ClaimBeforeEditRow): boolean {
  return (
    claim.session_id === edit.session_id || sameRepoBranch(edit, claim) || sameWorktree(edit, claim)
  );
}

function sameAgentIdentity(edit: ClaimBeforeEditRow, claim: ClaimBeforeEditRow): boolean {
  const editAgent = normalizeAgentIdentity(edit.agent_identity);
  const claimAgent = normalizeAgentIdentity(claim.agent_identity);
  return editAgent !== null && claimAgent !== null && editAgent === claimAgent;
}

function compatibleClaimScope(edit: ClaimBeforeEditRow, claim: ClaimBeforeEditRow): boolean {
  return (
    !knownRootMismatch(edit.repo_root, claim.repo_root) &&
    !knownValueMismatch(edit.branch, claim.branch) &&
    !knownRootMismatch(edit.worktree_path, claim.worktree_path)
  );
}

function knownRootMismatch(left: string | null, right: string | null): boolean {
  const normalizedLeft = normalizeRoot(left);
  const normalizedRight = normalizeRoot(right);
  return normalizedLeft !== null && normalizedRight !== null && normalizedLeft !== normalizedRight;
}

function knownValueMismatch(left: string | null, right: string | null): boolean {
  return left !== null && right !== null && left !== right;
}

function nullableSameRoot(left: string | null, right: string | null): boolean | null {
  const normalizedLeft = normalizeRoot(left);
  const normalizedRight = normalizeRoot(right);
  if (normalizedLeft === null || normalizedRight === null) return null;
  return normalizedLeft === normalizedRight;
}

function nullableSameValue(left: string | null, right: string | null): boolean | null {
  if (left === null || right === null) return null;
  return left === right;
}

function sameComparableFilePath(edit: ClaimBeforeEditRow, claim: ClaimBeforeEditRow): boolean {
  if (!edit.file_path || !claim.file_path) return false;
  const fallbackRoot = edit.repo_root ?? claim.repo_root;
  return (
    comparableFilePath(edit.file_path, edit.repo_root ?? fallbackRoot) ===
    comparableFilePath(claim.file_path, claim.repo_root ?? fallbackRoot)
  );
}

function comparableFilePath(filePath: string, repoRoot: string | null): string {
  const normalizedPath = normalizeSlashes(normalize(filePath.trim()));
  if (!repoRoot || !isAbsolute(normalizedPath)) {
    return stripManagedWorktreePrefix(trimCurrentDirPrefix(normalizedPath));
  }
  const root = resolve(repoRoot);
  const absolutePath = resolve(normalizedPath);
  const rel = relative(root, absolutePath);
  if (rel === '') return '.';
  if (!rel.startsWith('..') && !isAbsolute(rel))
    return stripManagedWorktreePrefix(normalizeSlashes(rel));
  return stripManagedWorktreePrefix(normalizeSlashes(absolutePath));
}

/**
 * Strip the managed agent-worktree prefix from a normalized path so that
 * an edit recorded inside `.omx/agent-worktrees/<lane>/<rest>` matches a
 * claim recorded for `<rest>` in the canonical repo. Without this, edit
 * paths from worktrees never line up with claims posted from the primary
 * checkout (or from a different worktree of the same file), and the
 * claim-before-edit metric reports a path mismatch even when the agent
 * did claim correctly. Symmetric — both edit and claim sides go through
 * `comparableFilePath`, so canonical-vs-canonical and worktree-vs-worktree
 * paths still compare equal.
 */
function stripManagedWorktreePrefix(value: string): string {
  if (!value) return value;
  const match = value.match(/(^|\/)\.(?:omx|omc)\/agent-worktrees\/[^/]+\/(.*)$/);
  if (!match || match[2] === undefined) return value;
  const rest = match[2];
  return rest === '' ? '.' : rest;
}

function normalizeRoot(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return canonicalManagedWorktreeRoot(normalizeSlashes(resolve(trimmed)));
}

function canonicalManagedWorktreeRoot(value: string): string {
  const marker = /\/\.(?:omx|omc)\/agent-worktrees\/[^/]+(?:\/|$)/;
  const match = marker.exec(value);
  if (!match || match.index === 0) return value;
  return value.slice(0, match.index);
}

function normalizeAgentIdentity(value: string | null): string | null {
  const raw = value?.trim().toLowerCase();
  if (!raw) return null;
  const prefix = raw.includes('@')
    ? (raw.split('@')[0] ?? raw)
    : raw.includes('/')
      ? (raw.split('/')[0] ?? raw)
      : raw;
  if (prefix.startsWith('claude')) return 'claude';
  if (prefix.startsWith('codex')) return 'codex';
  if (prefix.startsWith('omx')) return 'omx';
  return prefix || null;
}

function isPseudoClaimPath(filePath: string): boolean {
  const normalized = comparableFilePath(filePath, null);
  return (
    normalized === '' ||
    normalized === '/dev/null' ||
    normalized === 'dev/null' ||
    normalized === 'NUL'
  );
}

function trimCurrentDirPrefix(value: string): string {
  return value === '.' ? value : value.replace(/^\.\/+/, '');
}

function normalizeSlashes(value: string): string {
  return value.replaceAll('\\', '/');
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

function buildAggregateRow(
  row: McpMetricsOperationRawRow,
  costBasis: McpMetricsCostBasis,
  errorReasons: ReadonlyArray<McpMetricsErrorReason>,
): McpMetricsAggregateRow {
  const calls = row.calls ?? 0;
  const okCount = row.ok_count ?? 0;
  const errorCount = Math.max(0, calls - okCount);
  const successTokens = row.success_tokens ?? 0;
  const errorTokens = row.error_tokens ?? 0;
  const inBytes = row.in_bytes ?? 0;
  const outBytes = row.out_bytes ?? 0;
  const inTokens = row.in_tokens ?? 0;
  const outTokens = row.out_tokens ?? 0;
  const totalMs = row.total_ms ?? 0;
  const inputCost = metricCostUsd(inTokens, costBasis.input_usd_per_1m_tokens);
  const outputCost = metricCostUsd(outTokens, costBasis.output_usd_per_1m_tokens);
  const totalCost = roundMetricCost(inputCost + outputCost);
  return {
    operation: row.operation,
    calls,
    ok_count: okCount,
    error_count: errorCount,
    error_reasons: [...errorReasons],
    success_tokens: successTokens,
    error_tokens: errorTokens,
    avg_success_tokens: okCount === 0 ? 0 : Math.round(successTokens / okCount),
    avg_error_tokens: errorCount === 0 ? 0 : Math.round(errorTokens / errorCount),
    max_input_tokens: row.max_in_tokens ?? 0,
    max_output_tokens: row.max_out_tokens ?? 0,
    max_total_tokens: row.max_total_tokens ?? 0,
    max_duration_ms: row.max_ms ?? 0,
    input_bytes: inBytes,
    output_bytes: outBytes,
    total_bytes: inBytes + outBytes,
    input_tokens: inTokens,
    output_tokens: outTokens,
    total_tokens: inTokens + outTokens,
    input_cost_usd: inputCost,
    output_cost_usd: outputCost,
    total_cost_usd: totalCost,
    avg_cost_usd: calls === 0 ? 0 : roundMetricCost(totalCost / calls),
    avg_input_tokens: calls === 0 ? 0 : Math.round(inTokens / calls),
    avg_output_tokens: calls === 0 ? 0 : Math.round(outTokens / calls),
    total_duration_ms: totalMs,
    avg_duration_ms: calls === 0 ? 0 : Math.round(totalMs / calls),
    last_ts: row.last_ts ? row.last_ts : null,
  };
}

function buildSessionAggregateRow(
  row: McpMetricsSessionRawRow,
  costBasis: McpMetricsCostBasis,
): McpMetricsSessionAggregateRow {
  const calls = row.calls ?? 0;
  const okCount = row.ok_count ?? 0;
  const inBytes = row.in_bytes ?? 0;
  const outBytes = row.out_bytes ?? 0;
  const inTokens = row.in_tokens ?? 0;
  const outTokens = row.out_tokens ?? 0;
  const totalMs = row.total_ms ?? 0;
  const inputCost = metricCostUsd(inTokens, costBasis.input_usd_per_1m_tokens);
  const outputCost = metricCostUsd(outTokens, costBasis.output_usd_per_1m_tokens);
  const totalCost = roundMetricCost(inputCost + outputCost);
  return {
    session_id: row.session_id ?? '<unknown>',
    calls,
    ok_count: okCount,
    error_count: Math.max(0, calls - okCount),
    input_bytes: inBytes,
    output_bytes: outBytes,
    total_bytes: inBytes + outBytes,
    input_tokens: inTokens,
    output_tokens: outTokens,
    total_tokens: inTokens + outTokens,
    input_cost_usd: inputCost,
    output_cost_usd: outputCost,
    total_cost_usd: totalCost,
    avg_cost_usd: calls === 0 ? 0 : roundMetricCost(totalCost / calls),
    avg_input_tokens: calls === 0 ? 0 : Math.round(inTokens / calls),
    avg_output_tokens: calls === 0 ? 0 : Math.round(outTokens / calls),
    total_duration_ms: totalMs,
    avg_duration_ms: calls === 0 ? 0 : Math.round(totalMs / calls),
    last_ts: row.last_ts ? row.last_ts : null,
  };
}

function buildSessionSummary(
  totals: McpMetricsAggregateRow,
  sessionCount: number,
  sessionsTruncated: boolean,
): McpMetricsSessionSummary {
  return {
    session_count: sessionCount,
    sessions_truncated: sessionsTruncated,
    avg_calls: sessionCount === 0 ? 0 : Math.round(totals.calls / sessionCount),
    avg_input_tokens: sessionCount === 0 ? 0 : Math.round(totals.input_tokens / sessionCount),
    avg_output_tokens: sessionCount === 0 ? 0 : Math.round(totals.output_tokens / sessionCount),
    avg_total_tokens: sessionCount === 0 ? 0 : Math.round(totals.total_tokens / sessionCount),
    avg_total_cost_usd:
      sessionCount === 0 ? 0 : roundMetricCost(totals.total_cost_usd / sessionCount),
    last_ts: totals.last_ts,
  };
}

function normalizeMcpSessionLimit(value: number | undefined): number {
  if (value === undefined) return 12;
  if (!Number.isFinite(value) || value < 0) return 12;
  return Math.floor(value);
}

function normalizeMcpErrorReason(row: McpMetricsErrorReasonRawRow): McpMetricsErrorReason {
  return {
    error_code: emptyToNull(row.error_code),
    error_message: emptyToNull(row.error_message),
    count: row.count ?? 0,
    last_ts: row.last_ts ?? null,
  };
}

function emptyToNull(value: string | null): string | null {
  return value && value.trim() !== '' ? value : null;
}

function normalizeMcpCostBasis(
  cost: AggregateMcpMetricsOptions['cost'] | undefined,
): McpMetricsCostBasis {
  const inputRate = normalizeMcpCostRate(cost?.input_usd_per_1m_tokens);
  const outputRate = normalizeMcpCostRate(cost?.output_usd_per_1m_tokens);
  return {
    input_usd_per_1m_tokens: inputRate,
    output_usd_per_1m_tokens: outputRate,
    configured: inputRate > 0 || outputRate > 0,
  };
}

function normalizeMcpCostRate(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;
}

function metricCostUsd(tokens: number, usdPer1mTokens: number): number {
  return roundMetricCost((tokens / 1_000_000) * usdPer1mTokens);
}

function roundMetricCost(value: number): number {
  return Number(value.toFixed(12));
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

function isTaskClaimRow(row: TaskClaimRow | undefined): row is TaskClaimRow {
  return row !== undefined;
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

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseStringArray(value: string | null): string[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim() !== '',
  );
}

function sanitizeMatch(q: string): string {
  // Escape double quotes and wrap each bare term to avoid FTS5 syntax errors.
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

function searchTerms(q: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const match of q.toLowerCase().matchAll(/[a-z0-9_]+/g)) {
    const term = match[0];
    if (term.length < 2 || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

function prefixMatchQuery(terms: string[]): string {
  const reserved = new Set(['and', 'or', 'not', 'near']);
  return terms
    .map((term) => (term.length >= 3 && !reserved.has(term) ? `${term}*` : `"${term}"`))
    .join(' ');
}

function mergeSearchHits(hits: SearchHit[], limit: number): SearchHit[] {
  const byId = new Map<number, SearchHit>();
  for (const hit of hits) {
    const current = byId.get(hit.id);
    if (!current || hit.score > current.score) {
      byId.set(hit.id, hit);
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => b.score - a.score || b.ts - a.ts || b.id - a.id)
    .slice(0, limit);
}

function fuzzyContentScore(queryTerms: string[], content: string): number {
  const contentTerms = searchTerms(content);
  if (contentTerms.length === 0) return 0;
  let total = 0;
  let matched = 0;
  for (const queryTerm of queryTerms) {
    let best = 0;
    for (const contentTerm of contentTerms) {
      best = Math.max(best, fuzzyTermScore(queryTerm, contentTerm));
      if (best === 1) break;
    }
    if (best >= 0.55) {
      matched += 1;
      total += best;
    }
  }
  if (matched === 0) return 0;
  const coverage = matched / queryTerms.length;
  return (total / queryTerms.length) * coverage;
}

function fuzzyTermScore(queryTerm: string, contentTerm: string): number {
  if (queryTerm === contentTerm) return 1;
  if (queryTerm.length >= 3 && contentTerm.startsWith(queryTerm)) return 0.9;
  if (contentTerm.length >= 3 && queryTerm.startsWith(contentTerm)) return 0.75;
  if (Math.min(queryTerm.length, contentTerm.length) < 4) return 0;
  const distance = damerauLevenshtein(queryTerm, contentTerm, 2);
  if (distance === 1) return 0.72;
  if (distance === 2) return 0.58;
  return 0;
}

function damerauLevenshtein(a: string, b: string, maxDistance: number): number {
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  const previousPrevious = new Array<number>(b.length + 1).fill(0);
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = current[0] ?? i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (previousPrevious[j - 2] ?? 0) + 1);
      }
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    previousPrevious.splice(0, previousPrevious.length, ...previous);
    previous = current;
  }
  return previous[b.length] ?? maxDistance + 1;
}
