import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_TS, type ScenarioContext } from './setup.mjs';
import { ScenarioConfigError } from './run.mjs';

/**
 * Shape of expected.json. All arrays use subset matchers via
 * vitest's `toMatchObject` semantics, so each entry only has to assert
 * the fields it cares about. Order is significant: entry 0 in expected
 * must match the first live row of that kind that survives filters.
 */
export interface ExpectedSubstrate {
  observations?: ExpectedObservation[];
  claims?: ExpectedClaim[];
  mcp_metrics?: ExpectedMcpMetric[];
  lifecycle_events?: ExpectedLifecycleEvent[];
}

export interface ExpectedObservation {
  kind: string;
  ts_offset?: number;
  /** Subset-match over the JSON-parsed metadata column. */
  metadata_subset?: Record<string, unknown>;
}

export interface ExpectedClaim {
  task_id?: number;
  file_path: string;
  session_id?: string;
  state?: string;
}

export interface ExpectedMcpMetric {
  operation: string;
  session_id?: string;
  ok?: boolean;
}

export interface ExpectedLifecycleEvent {
  event_type: string;
  event_id?: string;
  parent_event_id?: string;
}

/**
 * Normalized live substrate the runner exposes to the diff. Everything
 * is plain JSON so it survives the same `toMatchObject` semantics
 * that drive subset matchers.
 */
export interface LiveSubstrate {
  observations: Array<{
    kind: string;
    ts_offset: number;
    metadata_subset: Record<string, unknown> | null;
  }>;
  claims: Array<{
    task_id: number;
    file_path: string;
    session_id: string;
    state: string;
  }>;
  mcp_metrics: Array<{ operation: string; session_id: string | null; ok: boolean }>;
  lifecycle_events: Array<{
    event_type: string;
    event_id: string;
    parent_event_id: string | null;
  }>;
}

/**
 * Collect the live substrate after a scenario run. Paths get rewritten
 * to `<REPO_ROOT>` so the diff doesn't depend on the tempdir name.
 */
export function collectLiveSubstrate(ctx: ScenarioContext): LiveSubstrate {
  const storageWithDb = ctx.store.storage as unknown as {
    db: { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] } };
  };
  const db = storageWithDb.db;

  const obsRows = db
    .prepare(
      'SELECT id, kind, ts, metadata FROM observations ORDER BY ts ASC, id ASC',
    )
    .all() as Array<{ id: number; kind: string; ts: number; metadata: string | null }>;

  const claimRows = db
    .prepare(
      'SELECT task_id, file_path, session_id, state FROM task_claims ORDER BY task_id ASC, file_path ASC',
    )
    .all() as Array<{ task_id: number; file_path: string; session_id: string; state: string }>;

  const mcpRows = db
    .prepare('SELECT operation, session_id, ok FROM mcp_metrics ORDER BY ts ASC, rowid ASC')
    .all() as Array<{ operation: string; session_id: string | null; ok: number }>;

  return {
    observations: obsRows.map((row) => ({
      kind: row.kind,
      ts_offset: row.ts - BASE_TS,
      metadata_subset: parseMetadata(row.metadata, ctx.repoRoot),
    })),
    claims: claimRows.map((row) => ({
      task_id: row.task_id,
      file_path: normalizePath(row.file_path, ctx.repoRoot),
      session_id: row.session_id,
      state: row.state,
    })),
    mcp_metrics: mcpRows.map((row) => ({
      operation: row.operation,
      session_id: row.session_id,
      ok: row.ok === 1,
    })),
    lifecycle_events: obsRows
      .filter((row) => row.kind === 'omx-lifecycle')
      .map((row) => {
        const meta = parseMetadata(row.metadata, ctx.repoRoot) ?? {};
        return {
          event_type: stringOr(meta.event_type, ''),
          event_id: stringOr(meta.event_id, ''),
          parent_event_id: typeof meta.parent_event_id === 'string' ? meta.parent_event_id : null,
        };
      }),
  };
}

function parseMetadata(
  raw: string | null,
  repoRoot: string,
): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return normalizeDeep(parsed, repoRoot) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeDeep(value: unknown, repoRoot: string): unknown {
  if (typeof value === 'string') return normalizePath(value, repoRoot);
  if (Array.isArray(value)) return value.map((v) => normalizeDeep(v, repoRoot));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeDeep(v, repoRoot);
    }
    return out;
  }
  return value;
}

function normalizePath(value: string, repoRoot: string): string {
  if (value.length === 0) return value;
  // Replace the tempdir prefix with a stable placeholder so diffs are
  // path-stable. `repoRoot` is the absolute path of the temp repo dir.
  return value.split(repoRoot).join('<REPO_ROOT>');
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Load expected.json for a scenario or throw a clear error. Fails closed
 * — a missing expected.json must not silently let a scenario pass.
 */
export function loadExpected(scenarioDir: string): ExpectedSubstrate {
  const expectedPath = join(scenarioDir, 'expected.json');
  if (!existsSync(expectedPath)) {
    throw new ScenarioConfigError(
      `missing expected.json — scenario at ${scenarioDir} has no expected substrate to diff against`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(expectedPath, 'utf8'));
  } catch (err) {
    throw new ScenarioConfigError(
      `expected.json at ${expectedPath} is invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new ScenarioConfigError(`expected.json at ${expectedPath} must be an object`);
  }
  return parsed as ExpectedSubstrate;
}

/**
 * Assert subset-match for each expected array entry against the live
 * substrate. Errors include the scenario slug, the offending key path,
 * and both actual and expected JSON so authors can see the diff inline.
 */
export function assertExpectedMatch(
  slug: string,
  expected: ExpectedSubstrate,
  live: LiveSubstrate,
): void {
  if (expected.observations) {
    assertArraySubset(slug, 'observations', expected.observations, live.observations);
  }
  if (expected.claims) {
    assertArraySubset(slug, 'claims', expected.claims, live.claims);
  }
  if (expected.mcp_metrics) {
    assertArraySubset(slug, 'mcp_metrics', expected.mcp_metrics, live.mcp_metrics);
  }
  if (expected.lifecycle_events) {
    assertArraySubset(slug, 'lifecycle_events', expected.lifecycle_events, live.lifecycle_events);
  }
}

function assertArraySubset(
  slug: string,
  arrayKey: string,
  expected: unknown[],
  live: unknown[],
): void {
  if (live.length < expected.length) {
    throw new ScenarioMismatchError(
      slug,
      `${arrayKey}.length`,
      live.length,
      `>= ${expected.length}`,
    );
  }
  for (let i = 0; i < expected.length; i += 1) {
    const mismatch = findSubsetMismatch(live[i], expected[i], `${arrayKey}[${i}]`);
    if (mismatch) {
      throw new ScenarioMismatchError(slug, mismatch.path, mismatch.actual, mismatch.expected);
    }
  }
}

/**
 * Hand-rolled subset-match (`toMatchObject` semantics) returning the
 * deepest mismatch point. Built in-house so the harness can run from
 * record.ts without dragging vitest's runtime into the import graph.
 *
 * Rules:
 *   - primitives compared by value
 *   - arrays: live must include each expected element in same order;
 *     elements compared recursively as subsets
 *   - objects: every key in expected must subset-match in live
 *   - keys present in live but absent in expected are ignored
 */
function findSubsetMismatch(
  actual: unknown,
  expected: unknown,
  path: string,
): { path: string; actual: unknown; expected: unknown } | null {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return { path, actual, expected };
    }
    if (actual.length < expected.length) {
      return { path: `${path}.length`, actual: actual.length, expected: expected.length };
    }
    for (let i = 0; i < expected.length; i += 1) {
      const inner = findSubsetMismatch(actual[i], expected[i], `${path}[${i}]`);
      if (inner) return inner;
    }
    return null;
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      return { path, actual, expected };
    }
    for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
      const innerPath = `${path}.${k}`;
      const inner = findSubsetMismatch((actual as Record<string, unknown>)[k], v, innerPath);
      if (inner) return inner;
    }
    return null;
  }
  // primitive
  if (actual !== expected) {
    return { path, actual, expected };
  }
  return null;
}

export class ScenarioMismatchError extends Error {
  readonly slug: string;
  readonly keyPath: string;
  readonly actual: unknown;
  readonly expected: unknown;

  constructor(slug: string, keyPath: string, actual: unknown, expected: unknown) {
    super(
      `scenario "${slug}" mismatch at ${keyPath}\n` +
        `  expected: ${stringify(expected)}\n` +
        `  actual:   ${stringify(actual)}`,
    );
    this.name = 'ScenarioMismatchError';
    this.slug = slug;
    this.keyPath = keyPath;
    this.actual = actual;
    this.expected = expected;
  }
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
