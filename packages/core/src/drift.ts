// Token-per-call drift detector. Pure function: takes the raw rows the
// storage method emits and classifies each operation into one of six
// buckets. No DB access here — keeps the classifier easy to unit-test
// in isolation and lets the CLI and MCP tool share one implementation.

export type DriftClassification =
  | 'up_drift'
  | 'down_drift'
  | 'new_tool'
  | 'gone'
  | 'insufficient_data'
  | 'stable';

export interface DriftRawRow {
  operation: string;
  baseline_median: number | null;
  baseline_n: number;
  recent_median: number | null;
  recent_n: number;
}

export interface DriftRow {
  operation: string;
  baseline_median: number | null;
  baseline_n: number;
  recent_median: number | null;
  recent_n: number;
  ratio: number | null;
  classification: DriftClassification;
}

export interface DriftClassifyOptions {
  /** Inclusive ratio cut-off for `up_drift` (e.g. 1.25 = +25%). */
  threshold: number;
  /** Inclusive ratio cut-off for `down_drift` (e.g. 0.75 = -25%). */
  down_threshold: number;
  /** Minimum sample size in each window to trust the median signal. */
  min_calls: number;
}

export interface DriftReport {
  threshold: {
    up: number;
    down: number;
    min_calls: number;
  };
  rows: DriftRow[];
  new_tools: string[];
  gone_tools: string[];
  insufficient_data: Array<{ operation: string; baseline_n: number; recent_n: number }>;
}

/**
 * Classify each tool's tokens-per-call drift between a baseline and a
 * recent window. The caller is responsible for picking non-overlapping
 * windows; this function only consumes the rows.
 *
 * Buckets (evaluated in order):
 *   - `new_tool`: no baseline data, recent has >= min_calls samples
 *   - `gone`: no recent data, baseline has >= min_calls samples
 *   - `insufficient_data`: either window below min_calls (not new/gone)
 *   - `up_drift`: ratio >= threshold AND both windows >= min_calls
 *   - `down_drift`: ratio <= down_threshold AND both windows >= min_calls
 *   - `stable`: otherwise
 *
 * The returned `rows` array preserves every row from the input so callers
 * can render the full table; the convenience arrays (`new_tools`,
 * `gone_tools`, `insufficient_data`) point at the same operations for
 * one-line summary lines.
 */
export function classifyDrift(
  rawRows: ReadonlyArray<DriftRawRow>,
  opts: DriftClassifyOptions,
): DriftReport {
  const rows: DriftRow[] = rawRows.map((raw) => {
    const ratio = computeRatio(raw.baseline_median, raw.recent_median);
    const classification = classifyOne(raw, ratio, opts);
    return {
      operation: raw.operation,
      baseline_median: raw.baseline_median,
      baseline_n: raw.baseline_n,
      recent_median: raw.recent_median,
      recent_n: raw.recent_n,
      ratio,
      classification,
    };
  });

  const new_tools = rows
    .filter((row) => row.classification === 'new_tool')
    .map((row) => row.operation);
  const gone_tools = rows
    .filter((row) => row.classification === 'gone')
    .map((row) => row.operation);
  const insufficient_data = rows
    .filter((row) => row.classification === 'insufficient_data')
    .map((row) => ({
      operation: row.operation,
      baseline_n: row.baseline_n,
      recent_n: row.recent_n,
    }));

  return {
    threshold: {
      up: opts.threshold,
      down: opts.down_threshold,
      min_calls: opts.min_calls,
    },
    rows,
    new_tools,
    gone_tools,
    insufficient_data,
  };
}

function classifyOne(
  raw: DriftRawRow,
  ratio: number | null,
  opts: DriftClassifyOptions,
): DriftClassification {
  const hasBaseline = raw.baseline_n >= opts.min_calls;
  const hasRecent = raw.recent_n >= opts.min_calls;
  if (raw.baseline_n === 0 && hasRecent) return 'new_tool';
  if (raw.recent_n === 0 && hasBaseline) return 'gone';
  if (!hasBaseline || !hasRecent) return 'insufficient_data';
  if (ratio === null) return 'stable';
  if (ratio >= opts.threshold) return 'up_drift';
  if (ratio <= opts.down_threshold) return 'down_drift';
  return 'stable';
}

function computeRatio(
  baseline: number | null,
  recent: number | null,
): number | null {
  if (baseline === null || recent === null) return null;
  if (baseline <= 0) return null;
  return recent / baseline;
}
