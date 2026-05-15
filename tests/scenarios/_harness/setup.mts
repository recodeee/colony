import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultSettings, type Settings } from '../../../packages/config/src/index.js';
import { MemoryStore } from '../../../packages/core/src/index.js';

/**
 * Anchor timestamp every scenario timeline offsets from. Pinning to a
 * fixed wall clock keeps `vi.setSystemTime(BASE_TS + at_ms)` reproducible
 * across machines and CI.
 */
export const BASE_TS = Date.parse('2026-05-16T10:00:00.000Z');

export interface ScenarioContext {
  /** Tempdir root; cleaned on teardown. */
  dir: string;
  /** Initialized git repo with a default branch. Substituted as <REPO_ROOT> in assertions. */
  repoRoot: string;
  /** Slug-isolated SQLite DB path. */
  dbPath: string;
  /** Live store used by the runner. */
  store: MemoryStore;
}

export interface SetupOptions {
  /** Scenario directory absolute path. Used to find seed.sql and meta.yaml. */
  scenarioDir: string;
  /** Default branch for the temp git repo. Scenarios may override per envelope. */
  defaultBranch?: string;
}

/**
 * Build a fresh scenario context: tempdir, git repo, MemoryStore (which
 * runs schema + migrations on first open), then apply seed.sql if
 * present. Embeddings are forced to provider=none so no scenario reaches
 * for the network or pulls a model.
 */
export function setupScenarioContext(opts: SetupOptions): ScenarioContext {
  const dir = mkdtempSync(join(tmpdir(), 'colony-scenario-'));
  const defaultBranch = opts.defaultBranch ?? 'agent/scenario/default';
  const repoRoot = tempGitRepo(dir, 'repo', defaultBranch);
  const dbPath = join(dir, 'state', 'colony.db');

  const settings: Settings = {
    ...defaultSettings,
    embedding: { ...defaultSettings.embedding, provider: 'none' },
  };

  const store = new MemoryStore({ dbPath, settings });

  const seedPath = join(opts.scenarioDir, 'seed.sql');
  if (existsSync(seedPath)) {
    const rawSql = readFileSync(seedPath, 'utf8').trim();
    if (rawSql.length > 0) {
      // Authors write <REPO_ROOT> in seed.sql so the same fixture stays
      // diff-stable across machines. Expand against the live tempdir
      // before the migrations-applied DB sees it.
      const sql = rawSql.split('<REPO_ROOT>').join(repoRoot);
      // `store.storage` is a `Storage` whose `.db` is a better-sqlite3
      // instance. We need .exec() for multi-statement seed SQL — the
      // public storage surface is row-oriented and doesn't expose it
      // verbatim. Cast to access the internal db handle.
      const storageWithDb = store.storage as unknown as { db: { exec: (sql: string) => void } };
      storageWithDb.db.exec(sql);
    }
  }

  return { dir, repoRoot, dbPath, store };
}

/**
 * Teardown is intentionally separate from setup so tests can attempt
 * teardown in `afterEach` even when the body threw.
 */
export function teardownScenarioContext(ctx: ScenarioContext | undefined): void {
  if (!ctx) return;
  try {
    ctx.store.close();
  } catch {
    // best-effort
  }
  try {
    rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function tempGitRepo(dir: string, name: string, branch: string): string {
  const repo = join(dir, name);
  mkdirSync(repo, { recursive: true });
  // -b lets `git init` create the repo with our desired default branch in
  // one shot, which matters because we drive lifecycle envelopes that
  // assert against `branch`. CI runners default to either `main` or
  // `master`, so being explicit avoids drift.
  execFileSync('git', ['init', '--quiet', '-b', branch, repo], { stdio: 'ignore' });
  mkdirSync(join(repo, 'src'), { recursive: true });
  // Seed two predictable target files so scenarios can pre/post edit
  // without each one needing its own setup step. Adding more is cheap;
  // removing one means rewriting fixtures.
  writeFileSync(join(repo, 'src/target.ts'), 'export const before = 1;\n', 'utf8');
  writeFileSync(join(repo, 'src/secondary.ts'), 'export const secondary = 1;\n', 'utf8');
  return repo;
}

/**
 * Ensure a directory exists for a file path we are about to write. The
 * scenarios runner uses this from envelope handlers and from
 * record/explain helpers.
 */
export function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}
