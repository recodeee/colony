import { loadSettings } from '@colony/config';
import {
  SAVINGS_REFERENCE_ROWS,
  type SavingsLiveComparison,
  type SavingsLiveComparisonCost,
  type SavingsReferenceRow,
  type SavingsReferenceTotals,
  savingsLiveComparison,
  savingsLiveComparisonCost,
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
  honest?: boolean;
  recentHours?: string;
  movers?: boolean;
}

export interface MoverRow {
  operation: string;
  recent_calls: number;
  prior_calls: number;
  recent_tokens: number;
  prior_tokens: number;
  recent_errors: number;
  prior_errors: number;
  recent_rate: number;
  prior_rate: number;
  calls_delta_pct: number | null;
  tokens_delta_pct: number | null;
  errors_delta_abs: number;
  state: 'new' | 'gone' | 'changed';
}

export interface MoversReport {
  recent_hours: number;
  prior_hours: number;
  recent_since: number;
  prior_since: number;
  total_recent_calls: number;
  total_prior_calls: number;
  risers: MoverRow[];
  fallers: MoverRow[];
  error_risers: MoverRow[];
  skipped_reason: string | null;
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
    .description('Show colony token/cost savings from live mcp_metrics receipts')
    .option('--json', 'emit structured JSON')
    .option('--hours <n>', 'live window in hours (default 168 = 7 days)')
    .option('--since <ms>', 'absolute epoch-ms cutoff; overrides --hours')
    .option('--operation <name>', 'filter live rows to one operation')
    .option('--session-limit <n>', 'number of live sessions to print (default 12; 0 = all)')
    .option('--reference', 'also print the static per-session reference catalog')
    .option('--honest', 'show only live mcp_metrics receipts; omit reference/comparison models')
    .option(
      '--recent-hours <n>',
      'trailing window in hours for the Movers section (default: window / 7)',
    )
    .option('--no-movers', 'hide the Movers (last vs prior) regression section')
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

      const moversEnabled = opts.movers !== false;
      const recentHours = resolveRecentHours(opts.recentHours, windowHours);
      const recentSince = recentHours !== null ? now - recentHours * 60 * 60_000 : null;

      const { live, recent } = await withStorage(
        settings,
        (storage) => {
          const sessionLimit = parseSessionLimit(opts.sessionLimit);
          const fullAgg = storage.aggregateMcpMetrics({
            since,
            until: now,
            ...(opts.operation !== undefined ? { operation: opts.operation } : {}),
            ...(sessionLimit !== undefined ? { sessionLimit } : {}),
            cost: costOptionsFromCli(opts),
          });
          const recentAgg =
            moversEnabled && recentSince !== null && recentSince > since
              ? storage.aggregateMcpMetrics({
                  since: recentSince,
                  until: now,
                  ...(opts.operation !== undefined ? { operation: opts.operation } : {}),
                  cost: costOptionsFromCli(opts),
                })
              : null;
          return { live: fullAgg, recent: recentAgg };
        },
        { readonly: true },
      );

      const movers =
        moversEnabled && recent !== null && recentHours !== null && recentSince !== null
          ? buildMoversReport({
              full: live.operations,
              recent: recent.operations,
              recentHours,
              priorHours: windowHours - recentHours,
              recentSince,
              priorSince: since,
            })
          : null;

      const referenceTotals = savingsReferenceTotals();
      const comparison = savingsLiveComparison(live.operations);
      const comparisonCost = live.cost_basis.configured
        ? savingsLiveComparisonCost(comparison, live.operations)
        : null;
      const livePayload = {
        live: {
          window: { since, until: now, hours: windowHours },
          ...(opts.operation !== undefined ? { operation: opts.operation } : {}),
          cost_basis: live.cost_basis,
          totals: live.totals,
          operations: live.operations,
          session_summary: live.session_summary,
          sessions: live.sessions,
          ...(movers !== null ? { movers } : {}),
        },
      };
      const payload =
        opts.honest === true
          ? {
              mode: 'honest_live_receipts',
              ...livePayload,
            }
          : {
              reference: {
                kind: 'static_per_session_model',
                note: 'Static hand-authored comparison model; not derived from the live mcp_metrics window.',
                rows: SAVINGS_REFERENCE_ROWS,
                totals: referenceTotals,
              },
              comparison,
              comparison_cost: comparisonCost,
              ...livePayload,
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
        opts.honest === true,
        movers,
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
  honest = false,
  movers: MoversReport | null = null,
): void {
  const comparison = savingsLiveComparison(liveRows, referenceRows);
  const comparisonCost = costBasis.configured
    ? savingsLiveComparisonCost(comparison, liveRows)
    : null;
  writeLiveSection(
    liveRows,
    liveTotals,
    sessionSummary,
    sessions,
    costBasis,
    hours,
    operationFilter,
    movers,
  );
  if (honest) return;
  process.stdout.write('\n');
  writeLiveComparisonSection(comparison, comparisonCost, hours, operationFilter);
  if (includeReference) {
    process.stdout.write('\n');
    writeReferenceSection(referenceRows, referenceTotals);
  }
}

export function writeLiveComparisonSection(
  comparison: SavingsLiveComparison,
  comparisonCost: SavingsLiveComparisonCost | null,
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
  writeGainFocus(comparison, comparisonCost);
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
  movers: MoversReport | null = null,
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
  if (movers !== null) {
    writeMoversSection(movers);
  }
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
    const share = totals.total_tokens > 0 ? topSpend.total_tokens / totals.total_tokens : 0;
    const shareLabel = formatShare(share);
    w.write(
      `${kleur.dim('Top spend:')} ${topSpend.operation} ${formatTokens(
        topSpend.total_tokens,
      )} tokens (${shareLabel} of total) across ${topSpend.calls} call${
        topSpend.calls === 1 ? '' : 's'
      } (avg ${formatTokens(avgTokens(topSpend))}/call)\n`,
    );
    if (share >= 0.7 && topSpend.calls >= 100) {
      w.write(
        `${kleur.yellow('Hot loop:')} ${topSpend.operation} dominates token spend ` +
          `(${shareLabel}); narrow filters, raise compact mode, or cache the result.\n`,
      );
    }
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
  const costSuffix = costBasis.configured
    ? `, ${formatUsdConfigured(summary.avg_total_cost_usd)}`
    : '';
  w.write(
    kleur.dim(
      `Sessions with receipts: ${summary.session_count}${truncation}; avg/session: ${summary.avg_calls} calls, ${formatTokens(
        summary.avg_total_tokens,
      )} tokens${costSuffix}.\n`,
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

function writeGainFocus(
  comparison: SavingsLiveComparison,
  comparisonCost: SavingsLiveComparisonCost | null,
): void {
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
      `${kleur.dim('Net:')} ${formatTokenDelta(savedTokens)}`,
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
  if (comparisonCost !== null && comparisonCost.totals.calls > 0) {
    process.stdout.write(
      [
        `${kleur.dim('Net USD:')} ${formatUsdDelta(comparisonCost.totals.saved_cost_usd)}`,
        `${kleur.dim('Colony spent:')} ${formatUsdConfigured(
          comparisonCost.totals.colony_cost_usd,
        )}`,
        `${kleur.dim('Standard est:')} ${formatUsdConfigured(
          comparisonCost.totals.baseline_cost_usd,
        )}`,
      ].join('  '),
    );
    process.stdout.write('\n');
    process.stdout.write(`${kleur.dim(`${comparisonCost.note}\n`)}`);
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

const MOVER_MIN_HOURS = 4;
const MOVER_MIN_CALLS = 5;
const MOVER_RATE_THRESHOLD = 2;
const MOVER_ERROR_MIN = 3;
const MOVER_ERROR_THRESHOLD = 3;
const MOVER_DISPLAY_LIMIT = 3;

function resolveRecentHours(raw: string | undefined, windowHours: number): number | null {
  if (windowHours < MOVER_MIN_HOURS) return null;
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= windowHours) return null;
    return parsed;
  }
  return Math.max(windowHours / 7, 1);
}

export function buildMoversReport(args: {
  full: ReadonlyArray<McpMetricsAggregateRow>;
  recent: ReadonlyArray<McpMetricsAggregateRow>;
  recentHours: number;
  priorHours: number;
  recentSince: number;
  priorSince: number;
}): MoversReport {
  const { full, recent, recentHours, priorHours, recentSince, priorSince } = args;
  const recentByOp = new Map<string, McpMetricsAggregateRow>();
  for (const row of recent) recentByOp.set(row.operation, row);
  const rows: MoverRow[] = [];
  let totalRecentCalls = 0;
  let totalPriorCalls = 0;

  for (const fullRow of full) {
    const recentRow = recentByOp.get(fullRow.operation);
    const recentCalls = recentRow?.calls ?? 0;
    const priorCalls = Math.max(0, fullRow.calls - recentCalls);
    const recentTokens = recentRow?.total_tokens ?? 0;
    const priorTokens = Math.max(0, fullRow.total_tokens - recentTokens);
    const recentErrors = recentRow?.error_count ?? 0;
    const priorErrors = Math.max(0, fullRow.error_count - recentErrors);
    totalRecentCalls += recentCalls;
    totalPriorCalls += priorCalls;

    const recentRate = recentHours > 0 ? recentCalls / recentHours : 0;
    const priorRate = priorHours > 0 ? priorCalls / priorHours : 0;
    const state: MoverRow['state'] =
      priorCalls === 0 && recentCalls > 0
        ? 'new'
        : recentCalls === 0 && priorCalls > 0
          ? 'gone'
          : 'changed';

    rows.push({
      operation: fullRow.operation,
      recent_calls: recentCalls,
      prior_calls: priorCalls,
      recent_tokens: recentTokens,
      prior_tokens: priorTokens,
      recent_errors: recentErrors,
      prior_errors: priorErrors,
      recent_rate: recentRate,
      prior_rate: priorRate,
      calls_delta_pct: rateDeltaPct(recentRate, priorRate),
      tokens_delta_pct: rateDeltaPct(
        recentHours > 0 ? recentTokens / recentHours : 0,
        priorHours > 0 ? priorTokens / priorHours : 0,
      ),
      errors_delta_abs: recentErrors - priorErrors,
      state,
    });
  }

  const skippedReason =
    totalRecentCalls + totalPriorCalls === 0
      ? 'no calls in either window'
      : recentHours <= 0 || priorHours <= 0
        ? 'window cannot be split'
        : null;

  if (skippedReason !== null) {
    return {
      recent_hours: recentHours,
      prior_hours: priorHours,
      recent_since: recentSince,
      prior_since: priorSince,
      total_recent_calls: totalRecentCalls,
      total_prior_calls: totalPriorCalls,
      risers: [],
      fallers: [],
      error_risers: [],
      skipped_reason: skippedReason,
    };
  }

  const risers = rows
    .filter(
      (row) =>
        row.recent_calls >= MOVER_MIN_CALLS &&
        (row.state === 'new' ||
          (row.prior_rate > 0 && row.recent_rate >= row.prior_rate * MOVER_RATE_THRESHOLD)),
    )
    .sort((a, b) => moverScore(b, 'rise') - moverScore(a, 'rise'))
    .slice(0, MOVER_DISPLAY_LIMIT);

  const fallers = rows
    .filter(
      (row) =>
        row.prior_calls >= MOVER_MIN_CALLS &&
        (row.state === 'gone' ||
          (row.recent_rate > 0 && row.prior_rate >= row.recent_rate * MOVER_RATE_THRESHOLD)),
    )
    .sort((a, b) => moverScore(b, 'fall') - moverScore(a, 'fall'))
    .slice(0, MOVER_DISPLAY_LIMIT);

  const errorRisers = rows
    .filter(
      (row) =>
        row.recent_errors >= MOVER_ERROR_MIN &&
        row.recent_errors >= Math.max(row.prior_errors, 1) * MOVER_ERROR_THRESHOLD,
    )
    .sort((a, b) => b.recent_errors - b.prior_errors - (a.recent_errors - a.prior_errors))
    .slice(0, MOVER_DISPLAY_LIMIT);

  return {
    recent_hours: recentHours,
    prior_hours: priorHours,
    recent_since: recentSince,
    prior_since: priorSince,
    total_recent_calls: totalRecentCalls,
    total_prior_calls: totalPriorCalls,
    risers,
    fallers,
    error_risers: errorRisers,
    skipped_reason: null,
  };
}

function rateDeltaPct(recentRate: number, priorRate: number): number | null {
  if (priorRate <= 0) return null;
  return ((recentRate - priorRate) / priorRate) * 100;
}

function moverScore(row: MoverRow, direction: 'rise' | 'fall'): number {
  if (direction === 'rise') {
    if (row.state === 'new') return Number.MAX_SAFE_INTEGER - 1 + row.recent_calls;
    return row.calls_delta_pct ?? row.tokens_delta_pct ?? 0;
  }
  if (row.state === 'gone') return Number.MAX_SAFE_INTEGER - 1 + row.prior_calls;
  const fallByCalls = row.calls_delta_pct !== null ? -row.calls_delta_pct : 0;
  const fallByTokens = row.tokens_delta_pct !== null ? -row.tokens_delta_pct : 0;
  return Math.max(fallByCalls, fallByTokens);
}

export function writeMoversSection(movers: MoversReport): void {
  const w = process.stdout;
  if (movers.risers.length === 0 && movers.fallers.length === 0 && movers.error_risers.length === 0)
    return;
  const recentLabel = formatHoursLabel(movers.recent_hours);
  const priorLabel = formatHoursLabel(movers.prior_hours);
  w.write(`${kleur.bold('Movers')} ${kleur.dim(`(last ${recentLabel} vs prior ${priorLabel})`)}\n`);
  for (const row of movers.risers) {
    w.write(`  ${kleur.green('▲')} ${formatMoverLine(row)}\n`);
  }
  for (const row of movers.fallers) {
    w.write(`  ${kleur.cyan('▼')} ${formatMoverLine(row)}\n`);
  }
  for (const row of movers.error_risers) {
    w.write(
      `  ${kleur.red('!')} ${row.operation} errors ${row.prior_errors} -> ${row.recent_errors}` +
        ` (${formatTokenDeltaAbs(row.errors_delta_abs)})\n`,
    );
  }
}

function formatMoverLine(row: MoverRow): string {
  if (row.state === 'new') {
    return `${row.operation} (new) ${row.recent_calls} call${
      row.recent_calls === 1 ? '' : 's'
    }, ${formatTokens(row.recent_tokens)} tokens`;
  }
  if (row.state === 'gone') {
    return `${row.operation} (gone) was ${row.prior_calls} call${
      row.prior_calls === 1 ? '' : 's'
    }, ${formatTokens(row.prior_tokens)} tokens`;
  }
  const callsPart =
    row.calls_delta_pct !== null
      ? `calls ${formatSignedPct(row.calls_delta_pct)} (${formatHourlyRate(row.recent_rate)}/h vs ${formatHourlyRate(row.prior_rate)}/h)`
      : `calls ${row.recent_calls} vs ${row.prior_calls}`;
  const tokensPart =
    row.tokens_delta_pct !== null
      ? `tokens ${formatSignedPct(row.tokens_delta_pct)}`
      : `tokens ${formatTokens(row.recent_tokens)} vs ${formatTokens(row.prior_tokens)}`;
  return `${row.operation} ${callsPart}  ${tokensPart}`;
}

function formatHourlyRate(rate: number): string {
  if (rate >= 10) return `${Math.round(rate)}`;
  if (rate >= 1) return rate.toFixed(1);
  return rate.toFixed(2);
}

function formatSignedPct(value: number): string {
  const rounded = Math.abs(value) >= 10 ? Math.round(value) : Number(value.toFixed(1));
  const prefix = value > 0 ? '+' : '';
  const text = `${prefix}${rounded}%`;
  return value >= 0 ? kleur.green(text) : kleur.red(text);
}

function formatTokenDeltaAbs(value: number): string {
  const prefix = value > 0 ? '+' : value < 0 ? '-' : '';
  const text = `${prefix}${Math.abs(value)}`;
  return value >= 0 ? kleur.red(text) : kleur.green(text);
}

function formatHoursLabel(hours: number): string {
  if (hours >= 24) {
    const days = hours / 24;
    if (Number.isInteger(days)) return `${days}d`;
    return `${days.toFixed(1)}d`;
  }
  if (hours >= 1) {
    if (Number.isInteger(hours)) return `${hours}h`;
    return `${hours.toFixed(1)}h`;
  }
  return `${Math.round(hours * 60)}m`;
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
  return formatUsdConfigured(value);
}

function formatUsdConfigured(value: number): string {
  if (value === 0) return '$0';
  if (value < 0.000001) return '<$0.000001';
  if (value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

function formatUsdDelta(value: number): string {
  const formatted = formatUsdConfigured(Math.abs(value));
  return value >= 0 ? kleur.green(`${formatted} saved`) : kleur.red(`${formatted} over`);
}

function formatPercent(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  const value = (part / whole) * 100;
  if (Number.isInteger(value)) return `${value}%`;
  return `${value.toFixed(1)}%`;
}

function formatShare(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%';
  const pct = ratio * 100;
  if (pct >= 10) return `${Math.round(pct)}%`;
  return `${pct.toFixed(1)}%`;
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
