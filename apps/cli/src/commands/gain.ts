import { loadSettings } from '@colony/config';
import {
  SAVINGS_REFERENCE_ROWS,
  type SavingsReferenceRow,
  savingsReferenceTotals,
} from '@colony/core';
import type { McpMetricsAggregateRow } from '@colony/storage';
import type { Command } from 'commander';
import kleur from 'kleur';
import { withStorage } from '../util/store.js';

interface GainOptions {
  json?: boolean;
  hours?: string;
  since?: string;
  operation?: string;
}

export function registerGainCommand(program: Command): void {
  program
    .command('gain')
    .description('Show colony token savings: static reference + live mcp_metrics receipts')
    .option('--json', 'emit structured JSON')
    .option('--hours <n>', 'live window in hours (default 168 = 7 days)')
    .option('--since <ms>', 'absolute epoch-ms cutoff; overrides --hours')
    .option('--operation <name>', 'filter live rows to one operation')
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
        (storage) =>
          storage.aggregateMcpMetrics({
            since,
            until: now,
            ...(opts.operation !== undefined ? { operation: opts.operation } : {}),
          }),
        { readonly: true },
      );

      const referenceTotals = savingsReferenceTotals();
      const payload = {
        reference: {
          rows: SAVINGS_REFERENCE_ROWS,
          totals: referenceTotals,
        },
        live: {
          window: { since, until: now, hours: windowHours },
          ...(opts.operation !== undefined ? { operation: opts.operation } : {}),
          totals: live.totals,
          operations: live.operations,
        },
      };

      if (opts.json === true) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
      }

      writeReferenceSection(SAVINGS_REFERENCE_ROWS, referenceTotals);
      writeLiveSection(live.operations, live.totals, windowHours, opts.operation);
    });
}

function writeReferenceSection(
  rows: ReadonlyArray<SavingsReferenceRow>,
  totals: ReturnType<typeof savingsReferenceTotals>,
): void {
  const w = process.stdout;
  w.write(`${kleur.bold('colony gain — static reference')}\n`);
  w.write(kleur.dim('Hand-authored estimates per session. See colony --help for details.\n\n'));
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
        kleur.bold('Total / session'),
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
      'input/output measured by @colony/compress#countTokens; bytes are raw JSON payload sizes; ok=successful calls, err=throws.\n\n',
    ),
  );
  const head = padRow(
    [
      'Operation',
      'Calls',
      'OK',
      'Err',
      'Tok in',
      'Tok out',
      'Tok total',
      'Bytes',
      'Avg in',
      'Avg out',
      'Avg ms',
      'Last',
    ],
    [30, 6, 5, 5, 8, 8, 10, 8, 7, 8, 7, 10],
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
      formatTokens(row.total_bytes),
      formatTokens(row.avg_input_tokens),
      formatTokens(row.avg_output_tokens),
      String(row.avg_duration_ms),
      formatLastSeen(row.last_ts),
    ];
    w.write(`${padRow(cells, [30, 6, 5, 5, 8, 8, 10, 8, 7, 8, 7, 10])}\n`);
  }
  w.write(`${kleur.dim('-'.repeat(126))}\n`);
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
        formatTokens(totals.total_bytes),
        formatTokens(totals.avg_input_tokens),
        formatTokens(totals.avg_output_tokens),
        String(totals.avg_duration_ms),
        formatLastSeen(totalLastTs),
      ],
      [30, 6, 5, 5, 8, 8, 10, 8, 7, 8, 7, 10],
    )}\n`,
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
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
