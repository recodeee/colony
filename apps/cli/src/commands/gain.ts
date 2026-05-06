import { loadSettings } from '@colony/config';
import {
  SAVINGS_REFERENCE_ROWS,
  type SavingsLiveComparison,
  type SavingsReferenceRow,
  type SavingsReferenceTotals,
  savingsLiveComparison,
  savingsReferenceTotals,
} from '@colony/core';
import type {
  McpMetricsAggregateRow,
  McpMetricsCostBasis,
  McpMetricsSessionAggregateRow,
  McpMetricsSessionSummary,
} from '@colony/storage';
import type { Command } from 'commander';
import kleur from 'kleur';
import { withStorage } from '../util/store.js';

interface GainOptions {
  json?: boolean;
  hours?: string;
  since?: string;
  operation?: string;
  sessionLimit?: string;
  inputCostPer1m?: string;
  outputCostPer1m?: string;
  reference?: boolean;
}

interface TopErrorReason {
  operation: string;
  error_code: string | null;
  error_message: string | null;
  count: number;
  last_ts: number | null;
}

export function registerGainCommand(program: Command): void {
  program
    .command('gain')
    .description('Show colony token savings: live mcp_metrics receipts + comparison model')
    .option('--json', 'emit structured JSON')
    .option('--hours <n>', 'live window in hours (default 168 = 7 days)')
    .option('--since <ms>', 'absolute epoch-ms cutoff; overrides --hours')
    .option('--operation <name>', 'filter live rows to one operation')
    .option('--session-limit <n>', 'number of live sessions to print (default 12; 0 = all)')
    .option('--reference', 'also print the static per-session reference catalog')
    .option(
      '--input-cost-per-1m <usd>',
      'USD rate per 1M input tokens; env COLONY_MCP_INPUT_USD_PER_1M',
    )
    .option(
      '--output-cost-per-1m <usd>',
      'USD rate per 1M output tokens; env COLONY_MCP_OUTPUT_USD_PER_1M',
    )
    .action(async (opts: GainOptions) => {
      const settings = loadSettings();
      const hoursArg = opts.hours ? Number(opts.hours) : undefined;
      const sinceArg = opts.since ? Number(opts.since) : undefined;
      const windowHours =
        hoursArg !== undefined && Number.isFinite(hoursArg) && hoursArg > 0 ? hoursArg : 168;
      const now = Date.now();
      const since =
        sinceArg !== undefined && Number.isFinite(sinceArg) && sinceArg >= 0
          ? sinceArg
          : now - windowHours * 60 * 60_000;

      const live = await withStorage(
        settings,
        (storage) => {
          const sessionLimit = parseSessionLimit(opts.sessionLimit);
          return storage.aggregateMcpMetrics({
            since,
            until: now,
            ...(opts.operation !== undefined ? { operation: opts.operation } : {}),
            ...(sessionLimit !== undefined ? { sessionLimit } : {}),
            cost: costOptionsFromCli(opts),
          });
        },
        { readonly: true },
      );

      const referenceTotals = savingsReferenceTotals();
      const comparison = savingsLiveComparison(live.operations);
      const payload = {
        reference: {
          kind: 'static_per_session_model',
          note: 'Static hand-authored comparison model; not derived from the live mcp_metrics window.',
          rows: SAVINGS_REFERENCE_ROWS,
          totals: referenceTotals,
        },
        comparison,
        live: {
          window: { since, until: now, hours: windowHours },
          ...(opts.operation !== undefined ? { operation: opts.operation } : {}),
          cost_basis: live.cost_basis,
          totals: live.totals,
          operations: live.operations,
          session_summary: live.session_summary,
          sessions: live.sessions,
        },
      };

      if (opts.json === true) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
      }

      writeGainReport(
        SAVINGS_REFERENCE_ROWS,
        referenceTotals,
        live.operations,
        live.totals,
        live.session_summary,
        live.sessions,
        live.cost_basis,
        windowHours,
        opts.operation,
        opts.reference === true,
      );
    });
}

export function writeGainReport(
  referenceRows: ReadonlyArray<SavingsReferenceRow>,
  referenceTotals: SavingsReferenceTotals,
  liveRows: ReadonlyArray<McpMetricsAggregateRow>,
  liveTotals: McpMetricsAggregateRow,
  sessionSummary: McpMetricsSessionSummary,
  sessions: ReadonlyArray<McpMetricsSessionAggregateRow>,
  costBasis: McpMetricsCostBasis,
  hours: number,
  operationFilter: string | undefined,
  includeReference = false,
): void {
  const comparison = savingsLiveComparison(liveRows, referenceRows);
  writeLiveSection(
    liveRows,
    liveTotals,
    sessionSummary,
    sessions,
    costBasis,
    hours,
    operationFilter,
  );
  process.stdout.write('\n');
  writeLiveComparisonSection(comparison, hours, operationFilter);
  if (includeReference) {
    process.stdout.write('\n');
    writeReferenceSection(referenceRows, referenceTotals);
  }
}

export function writeLiveComparisonSection(
  comparison: SavingsLiveComparison,
  hours: number,
  operationFilter: string | undefined,
): void {
  const w = process.stdout;
  const filter = operationFilter ? ` (op=${operationFilter})` : '';
  w.write(`${kleur.bold(`colony gain — live comparison model (last ${hours}h${filter})`)}\n`);
  if (comparison.rows.length === 0) {
    w.write(
      kleur.dim(
        'No live operations matched the reference aliases in this window. Use --reference for the static catalog.\n',
      ),
    );
    writeUnmatchedComparisonSummary(comparison);
    return;
  }
  w.write(`${kleur.dim(`${comparison.note}\n\n`)}`);
  writeGainFocus(comparison);
  w.write('\n');
  const head = padRow(
    ['Operation', 'Calls', 'Standard', 'Colony', 'Saved', 'Matched ops'],
    [32, 7, 9, 9, 7, 32],
  );
  w.write(`${kleur.dim(head)}\n`);
  for (const row of comparison.rows) {
    w.write(
      `${padRow(
        [
          row.operation,
          String(row.calls),
          formatTokens(row.baseline_tokens),
          formatTokens(row.colony_tokens),
          formatSavingsPct(row.savings_pct),
          truncate(row.matched_operations.join(', '), 32),
        ],
        [32, 7, 9, 9, 7, 32],
      )}\n`,
    );
  }
  w.write(`${kleur.dim('-'.repeat(104))}\n`);
  w.write(
    `${padRow(
      [
        kleur.bold('Live matched total'),
        String(comparison.totals.calls),
        formatTokens(comparison.totals.baseline_tokens),
        formatTokens(comparison.totals.colony_tokens),
        formatSavingsPct(comparison.totals.savings_pct),
        '',
      ],
      [32, 7, 9, 9, 7, 32],
    )}\n`,
  );
  writeUnmatchedComparisonSummary(comparison);
}

export function writeReferenceSection(
  rows: ReadonlyArray<SavingsReferenceRow>,
  totals: SavingsReferenceTotals,
): void {
  const w = process.stdout;
  w.write(`${kleur.bold('colony gain — reference model (static)')}\n`);
  w.write(
    kleur.dim(
      'Static estimated per-session loops for comparison. This total does not move with the live window.\n\n',
    ),
  );
  const head = padRow(['Operation', 'Freq', 'Standard', 'Colony', 'Saved'], [32, 5, 9, 9, 6]);
  w.write(`${kleur.dim(head)}\n`);
  for (const row of rows) {
    const saved = `${row.savings_pct}%`;
    const cells = [
      row.operation,
      String(row.frequency_per_session),
      formatTokens(row.baseline_tokens),
      formatTokens(row.colony_tokens),
      saved,
    ];
    w.write(`${padRow(cells, [32, 5, 9, 9, 6])}\n`);
  }
  w.write(`${kleur.dim('-'.repeat(64))}\n`);
  w.write(
    `${padRow(
      [
        kleur.bold('Static total / session'),
        '',
        formatTokens(totals.baseline_tokens),
        formatTokens(totals.colony_tokens),
        kleur.green(`${totals.savings_pct}%`),
      ],
      [32, 5, 9, 9, 6],
    )}\n\n`,
  );
}

export function writeLiveSection(
  rows: ReadonlyArray<McpMetricsAggregateRow>,
  totals: McpMetricsAggregateRow,
  sessionSummary: McpMetricsSessionSummary,
  sessions: ReadonlyArray<McpMetricsSessionAggregateRow>,
  costBasis: McpMetricsCostBasis,
  hours: number,
  operationFilter: string | undefined,
): void {
  const w = process.stdout;
  const filter = operationFilter ? ` (op=${operationFilter})` : '';
  w.write(`${kleur.bold(`colony gain — live mcp_metrics (last ${hours}h${filter})`)}\n`);
  if (totals.calls === 0) {
    w.write(
      kleur.dim(
        'No mcp_metrics rows in window. Use the colony MCP tools or run agents with the colony MCP server registered to populate.\n',
      ),
    );
    return;
  }
  w.write(
    kleur.dim(
      `Measured by @colony/compress#countTokens. Cost: ${formatCostBasis(
        costBasis,
      )}. OK=successful calls; Err=throws or MCP isError.\n`,
    ),
  );
  writeLiveOverview(rows, totals, sessionSummary, costBasis);
  w.write('\n');
  w.write(`${kleur.bold('Operations')}\n`);
  const head = padRow(
    [
      'Operation',
      'Calls',
      'OK',
      'Err',
      'Tok in',
      'Tok out',
      'Tok total',
      'Cost',
      'Avg cost',
      'Bytes',
      'Avg in',
      'Avg out',
      'Avg ms',
      'Last',
    ],
    [30, 6, 5, 5, 8, 8, 10, 11, 11, 8, 7, 8, 7, 10],
  );
  w.write(`${kleur.dim(head)}\n`);
  for (const row of rows) {
    const cells = [
      row.operation,
      String(row.calls),
      String(row.ok_count),
      row.error_count > 0 ? kleur.red(String(row.error_count)) : '0',
      formatTokens(row.input_tokens),
      formatTokens(row.output_tokens),
      formatTokens(row.total_tokens),
      formatUsd(row.total_cost_usd, costBasis),
      formatUsd(row.avg_cost_usd, costBasis),
      formatTokens(row.total_bytes),
      formatTokens(row.avg_input_tokens),
      formatTokens(row.avg_output_tokens),
      String(row.avg_duration_ms),
      formatLastSeen(row.last_ts),
    ];
    w.write(`${padRow(cells, [30, 6, 5, 5, 8, 8, 10, 11, 11, 8, 7, 8, 7, 10])}\n`);
  }
  w.write(`${kleur.dim('-'.repeat(150))}\n`);
  const totalLastTs = totals.last_ts ?? latestMetricTs(rows);
  w.write(
    `${padRow(
      [
        kleur.bold('Total'),
        String(totals.calls),
        String(totals.ok_count),
        totals.error_count > 0 ? kleur.red(String(totals.error_count)) : '0',
        formatTokens(totals.input_tokens),
        formatTokens(totals.output_tokens),
        formatTokens(totals.total_tokens),
        formatUsd(totals.total_cost_usd, costBasis),
        formatUsd(totals.avg_cost_usd, costBasis),
        formatTokens(totals.total_bytes),
        formatTokens(totals.avg_input_tokens),
        formatTokens(totals.avg_output_tokens),
        String(totals.avg_duration_ms),
        formatLastSeen(totalLastTs),
      ],
      [30, 6, 5, 5, 8, 8, 10, 11, 11, 8, 7, 8, 7, 10],
    )}\n`,
  );
  writeLiveErrorReasons(rows, totals);
  writeOperationDetail(rows, operationFilter);
  writeLiveSessionSection(sessionSummary, sessions, costBasis);
}

function writeOperationDetail(
  rows: ReadonlyArray<McpMetricsAggregateRow>,
  operationFilter: string | undefined,
): void {
  if (operationFilter === undefined) return;
  const row = rows.find((candidate) => candidate.operation === operationFilter);
  if (row === undefined) return;
  const w = process.stdout;
  w.write('\n');
  w.write(`${kleur.bold('Operation detail')}\n`);
  w.write(
    [
      `${kleur.dim('Success tokens:')} ${formatTokens(row.success_tokens)}`,
      `${kleur.dim('Error tokens:')} ${formatTokens(row.error_tokens)}`,
      `${kleur.dim('Avg success:')} ${formatTokens(row.avg_success_tokens)}`,
      `${kleur.dim('Avg error:')} ${formatTokens(row.avg_error_tokens)}`,
    ].join('  '),
  );
  w.write('\n');
  w.write(
    [
      `${kleur.dim('Max tokens:')} ${formatTokens(row.max_total_tokens)}`,
      `${kleur.dim('Max in:')} ${formatTokens(row.max_input_tokens)}`,
      `${kleur.dim('Max out:')} ${formatTokens(row.max_output_tokens)}`,
      `${kleur.dim('Max ms:')} ${row.max_duration_ms}`,
    ].join('  '),
  );
  w.write('\n');
}

function writeLiveOverview(
  rows: ReadonlyArray<McpMetricsAggregateRow>,
  totals: McpMetricsAggregateRow,
  sessionSummary: McpMetricsSessionSummary,
  costBasis: McpMetricsCostBasis,
): void {
  const w = process.stdout;
  const totalLastTs = totals.last_ts ?? latestMetricTs(rows);
  const errorRate = formatPercent(totals.error_count, totals.calls);
  const errorStatus =
    totals.error_count > 0
      ? kleur.red(`${totals.error_count} (${errorRate})`)
      : kleur.green('0 (0%)');

  w.write(`${kleur.bold('At a glance')}\n`);
  w.write(
    [
      `${kleur.dim('Calls:')} ${totals.calls}`,
      `${kleur.dim('OK:')} ${totals.ok_count}`,
      `${kleur.dim('Errors:')} ${errorStatus}`,
      `${kleur.dim('Tokens:')} ${formatTokens(totals.total_tokens)}`,
      `${kleur.dim('Avg ms:')} ${totals.avg_duration_ms}`,
      `${kleur.dim('Last:')} ${formatLastSeen(totalLastTs)}`,
    ].join('  '),
  );
  w.write('\n');
  w.write(
    [
      `${kleur.dim('Sessions:')} ${sessionSummary.session_count}`,
      `${kleur.dim('Avg/session:')} ${sessionSummary.avg_calls} calls, ${formatTokens(
        sessionSummary.avg_total_tokens,
      )} tokens`,
      `${kleur.dim('Cost total:')} ${formatUsd(totals.total_cost_usd, costBasis)}`,
    ].join('  '),
  );
  w.write('\n');

  const topError = findTopErrorReason(rows);
  if (topError !== null) {
    w.write(
      `${kleur.red('Needs attention:')} ${topError.count}x ${topError.operation} ` +
        `${formatErrorCode(topError.error_code)} - ${formatErrorMessage(topError.error_message)}\n`,
    );
  }
  const topSpend = findTopTokenSpend(rows);
  if (topSpend !== null) {
    w.write(
      `${kleur.dim('Top spend:')} ${topSpend.operation} ${formatTokens(
        topSpend.total_tokens,
      )} tokens across ${topSpend.calls} call${topSpend.calls === 1 ? '' : 's'} ` +
        `(avg ${formatTokens(avgTokens(topSpend))}/call)\n`,
    );
  }
}

function writeLiveSessionSection(
  summary: McpMetricsSessionSummary,
  sessions: ReadonlyArray<McpMetricsSessionAggregateRow>,
  costBasis: McpMetricsCostBasis,
): void {
  if (summary.session_count === 0) return;
  const w = process.stdout;
  w.write('\n');
  w.write(`${kleur.bold('Live sessions')}\n`);
  const truncation = summary.sessions_truncated ? `; showing ${sessions.length}` : '';
  w.write(
    kleur.dim(
      `Sessions with receipts: ${summary.session_count}${truncation}; avg/session: ${summary.avg_calls} calls, ${formatTokens(
        summary.avg_total_tokens,
      )} tokens, ${formatUsd(summary.avg_total_cost_usd, costBasis)}.\n`,
    ),
  );
  const head = padRow(
    ['Session', 'Calls', 'OK', 'Err', 'Tok in', 'Tok out', 'Tok total', 'Cost', 'Last'],
    [22, 6, 5, 5, 8, 8, 10, 11, 10],
  );
  w.write(`${kleur.dim(head)}\n`);
  for (const row of sessions) {
    w.write(
      `${padRow(
        [
          formatSessionId(row.session_id),
          String(row.calls),
          String(row.ok_count),
          row.error_count > 0 ? kleur.red(String(row.error_count)) : '0',
          formatTokens(row.input_tokens),
          formatTokens(row.output_tokens),
          formatTokens(row.total_tokens),
          formatUsd(row.total_cost_usd, costBasis),
          formatLastSeen(row.last_ts),
        ],
        [22, 6, 5, 5, 8, 8, 10, 11, 10],
      )}\n`,
    );
  }
}

function writeLiveErrorReasons(
  rows: ReadonlyArray<McpMetricsAggregateRow>,
  totals: McpMetricsAggregateRow,
): void {
  if (totals.error_count === 0) return;
  const w = process.stdout;
  w.write('\n');
  w.write(`${kleur.bold('Top error reasons')}\n`);
  w.write(`${kleur.dim(padRow(['Operation', 'Err', 'Code', 'Message'], [30, 6, 24, 72]))}\n`);
  for (const row of rows.filter((r) => r.error_count > 0)) {
    const reason = row.error_reasons[0] ?? {
      error_code: null,
      error_message: null,
      count: row.error_count,
      last_ts: null,
    };
    w.write(
      `${padRow(
        [
          row.operation,
          kleur.red(String(reason.count)),
          formatErrorCode(reason.error_code),
          formatErrorMessage(reason.error_message),
        ],
        [30, 6, 24, 72],
      )}\n`,
    );
  }
}

function findTopErrorReason(rows: ReadonlyArray<McpMetricsAggregateRow>): TopErrorReason | null {
  let top: TopErrorReason | null = null;

  for (const row of rows) {
    if (row.error_count <= 0) continue;
    const reasons =
      row.error_reasons.length > 0
        ? row.error_reasons
        : [
            {
              error_code: null,
              error_message: null,
              count: row.error_count,
              last_ts: row.last_ts,
            },
          ];
    for (const reason of reasons) {
      const candidate = {
        operation: row.operation,
        error_code: reason.error_code,
        error_message: reason.error_message,
        count: reason.count,
        last_ts: reason.last_ts,
      };
      if (
        top === null ||
        candidate.count > top.count ||
        (candidate.count === top.count && (candidate.last_ts ?? 0) > (top.last_ts ?? 0))
      ) {
        top = candidate;
      }
    }
  }

  return top;
}

function writeGainFocus(comparison: SavingsLiveComparison): void {
  const matchedCalls = comparison.totals.calls;
  const totalCalls = matchedCalls + comparison.totals.unmatched_calls;
  const topSaving = findTopSaving(comparison);
  const savedTokens = comparison.totals.baseline_tokens - comparison.totals.colony_tokens;
  const next =
    comparison.totals.unmatched_calls > matchedCalls
      ? 'add reference aliases for high-volume unmatched operations'
      : savedTokens < 0
        ? 'inspect over-budget matched operations'
        : 'keep high-volume loops on Colony MCP surfaces';

  process.stdout.write(`${kleur.bold('Gain focus')}\n`);
  process.stdout.write(
    [
      `${kleur.dim('Coverage:')} ${matchedCalls} / ${totalCalls} live calls (${formatPercent(
        matchedCalls,
        totalCalls,
      )})`,
      `${kleur.dim('Saved:')} ${formatTokenDelta(savedTokens)}`,
      `${kleur.dim('Next:')} ${next}`,
    ].join('  '),
  );
  process.stdout.write('\n');
  if (topSaving !== null) {
    process.stdout.write(
      `${kleur.dim('Top saving:')} ${topSaving.operation} ${formatTokenDelta(
        topSaving.baseline_tokens - topSaving.colony_tokens,
      )} across ${topSaving.calls} call${topSaving.calls === 1 ? '' : 's'}\n`,
    );
  }
}

function findTopSaving(
  comparison: SavingsLiveComparison,
): SavingsLiveComparison['rows'][number] | null {
  let top: SavingsLiveComparison['rows'][number] | null = null;
  for (const row of comparison.rows) {
    if (
      top === null ||
      row.baseline_tokens - row.colony_tokens > top.baseline_tokens - top.colony_tokens
    ) {
      top = row;
    }
  }
  return top;
}

function findTopTokenSpend(
  rows: ReadonlyArray<McpMetricsAggregateRow>,
): McpMetricsAggregateRow | null {
  let top: McpMetricsAggregateRow | null = null;
  for (const row of rows) {
    if (top === null || row.total_tokens > top.total_tokens) top = row;
  }
  return top;
}

function writeUnmatchedComparisonSummary(comparison: SavingsLiveComparison): void {
  if (comparison.totals.unmatched_calls === 0) return;
  const operations = comparison.unmatched_operations
    .slice(0, 8)
    .map((row) => `${row.operation}:${row.calls}`)
    .join(', ');
  const suffix =
    comparison.unmatched_operations.length > 8
      ? `, +${comparison.unmatched_operations.length - 8} more`
      : '';
  process.stdout.write(
    kleur.dim(
      `Unmatched live operations: ${comparison.totals.unmatched_calls} calls, ${formatTokens(
        comparison.totals.unmatched_colony_tokens,
      )} tokens (${operations}${suffix}).\n`,
    ),
  );
}

function costOptionsFromCli(opts: GainOptions): {
  input_usd_per_1m_tokens?: number;
  output_usd_per_1m_tokens?: number;
} {
  const inputRate = parseCostRate(opts.inputCostPer1m, process.env.COLONY_MCP_INPUT_USD_PER_1M);
  const outputRate = parseCostRate(opts.outputCostPer1m, process.env.COLONY_MCP_OUTPUT_USD_PER_1M);
  return {
    ...(inputRate !== undefined ? { input_usd_per_1m_tokens: inputRate } : {}),
    ...(outputRate !== undefined ? { output_usd_per_1m_tokens: outputRate } : {}),
  };
}

function parseCostRate(raw: string | undefined, fallback: string | undefined): number | undefined {
  const value = raw ?? fallback;
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseSessionLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatSavingsPct(n: number): string {
  const value = `${n}%`;
  return n < 0 ? kleur.red(value) : kleur.green(value);
}

function formatTokenDelta(n: number): string {
  const value = n >= 0 ? `${formatTokens(n)} saved` : `${formatTokens(Math.abs(n))} over`;
  return n >= 0 ? kleur.green(value) : kleur.red(value);
}

function formatCostBasis(costBasis: McpMetricsCostBasis): string {
  if (!costBasis.configured) {
    return 'not configured (pass --input-cost-per-1m/--output-cost-per-1m or env)';
  }
  return `USD @ in=${formatRate(costBasis.input_usd_per_1m_tokens)}/1M out=${formatRate(
    costBasis.output_usd_per_1m_tokens,
  )}/1M`;
}

function formatRate(value: number): string {
  if (value === 0) return '$0';
  return `$${value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
}

function formatUsd(value: number, costBasis: McpMetricsCostBasis): string {
  if (!costBasis.configured) return '-';
  if (value === 0) return '$0';
  if (value < 0.000001) return '<$0.000001';
  if (value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

function formatPercent(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  const value = (part / whole) * 100;
  if (Number.isInteger(value)) return `${value}%`;
  return `${value.toFixed(1)}%`;
}

function avgTokens(row: Pick<McpMetricsAggregateRow, 'calls' | 'total_tokens'>): number {
  return row.calls <= 0 ? 0 : Math.round(row.total_tokens / row.calls);
}

function formatErrorCode(value: string | null): string {
  return value ?? 'UNKNOWN';
}

function formatErrorMessage(value: string | null): string {
  return truncate(value ?? 'older row; no error detail recorded', 72);
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function formatSessionId(value: string): string {
  if (value.length <= 22) return value;
  return `${value.slice(0, 10)}...${value.slice(-9)}`;
}

function latestMetricTs(rows: ReadonlyArray<McpMetricsAggregateRow>): number | null {
  let latest: number | null = null;
  for (const row of rows) {
    if (row.last_ts === null) continue;
    latest = latest === null ? row.last_ts : Math.max(latest, row.last_ts);
  }
  return latest;
}

function formatLastSeen(ts: number | null): string {
  if (ts === null) return '-';
  const ageMs = Math.max(0, Date.now() - ts);
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function padRow(cells: string[], widths: number[]): string {
  return cells
    .map((cell, i) => {
      const w = widths[i] ?? 12;
      return padVisible(cell, w);
    })
    .join('  ');
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function padVisible(value: string, width: number): string {
  const visibleLen = value.replace(ANSI, '').length;
  if (visibleLen >= width) return value;
  return `${value}${' '.repeat(width - visibleLen)}`;
}
