import {
  type SavingsLiveComparison,
  savingsLiveComparison,
  savingsLiveComparisonCost,
} from '@colony/core';
import type { McpMetricsAggregate, McpMetricsAggregateRow } from '@colony/storage';
import { html, layout, raw } from '../html.js';

export interface SavingsPagePayload {
  live: McpMetricsAggregate;
  windowHours: number;
}

export function renderSavingsPage(payload: SavingsPagePayload): string {
  const comparison = savingsLiveComparison(payload.live.operations);
  const live = renderLiveTable(payload.live, payload.windowHours);
  const value = renderReceiptValue(payload.live, comparison);
  const comparisonTable = renderLiveComparisonTable(comparison, payload.windowHours);
  const body = html`
    <p><a href="/">&larr; back to sessions</a></p>
    <h2>Token savings</h2>
    <p class="meta">
      Live <code>mcp_metrics</code> receipts recorded by the wrapping MCP handler, followed by a
      live comparison model for common coordination loops. Token counts use
      <code>@colony/compress#countTokens</code>, the same primitive as observation receipts.
      Monetary cost uses the configured USD per 1M token rates when present.
      The comparison table moves with the live window; unmatched operations stay visible in the
      raw live table.
    </p>
    ${raw(live)}
    ${raw(value)}
    ${raw(comparisonTable)}
  `;
  return layout('agents-hivemind · savings', body);
}

function renderReceiptValue(live: McpMetricsAggregate, comparison: SavingsLiveComparison): string {
  if (!live.cost_basis.configured) return '';
  const cost = savingsLiveComparisonCost(comparison, live.operations);
  if (cost.totals.calls === 0) return '';
  return html`
    <div class="card">
      <h2>Receipt value</h2>
      <p class="meta">${cost.note}</p>
      <p class="receipt-value">
        <strong>${formatUsd(cost.totals.saved_cost_usd, true)} saved</strong>
        <span>Colony spent ${formatUsd(cost.totals.colony_cost_usd, true)}</span>
        <span>Standard estimate ${formatUsd(cost.totals.baseline_cost_usd, true)}</span>
      </p>
      ${raw(savingsTableStyle)}
    </div>`;
}

function renderLiveComparisonTable(comparison: SavingsLiveComparison, windowHours: number): string {
  if (comparison.rows.length === 0) {
    return html`
      <div class="card">
        <h2>Live comparison: standard vs. colony (last ${windowHours}h)</h2>
        <p class="meta">
          No live operations matched the reference aliases in this window. The static catalog is
          still available from <code>colony gain --reference</code> and
          <code>savings_report.reference</code>.
        </p>
      </div>`;
  }
  const rows = comparison.rows
    .map(
      (row) => html`
        <tr>
          <td><strong>${row.operation}</strong></td>
          <td class="num">${row.calls}</td>
          <td class="num">${formatTokens(row.baseline_tokens)}</td>
          <td class="num">${formatTokens(row.colony_tokens)}</td>
          <td class="num savings-cell">${row.savings_pct}%</td>
          <td><code>${row.matched_operations.join(', ')}</code></td>
        </tr>`,
    )
    .join('');
  const unmatched = renderUnmatchedComparisonSummary(comparison);
  return html`
    <div class="card">
      <h2>Live comparison: standard vs. colony (last ${windowHours}h)</h2>
      <p class="meta">${comparison.note}</p>
      <table class="savings-table">
        <thead>
          <tr>
            <th>Operation</th>
            <th class="num">Calls</th>
            <th class="num">Standard</th>
            <th class="num">Colony</th>
            <th class="num">Saved</th>
            <th>Matched ops</th>
          </tr>
        </thead>
        <tbody>${raw(rows)}</tbody>
        <tfoot>
          <tr>
            <td><strong>Live matched total</strong></td>
            <td class="num"><strong>${comparison.totals.calls}</strong></td>
            <td class="num"><strong>${formatTokens(comparison.totals.baseline_tokens)}</strong></td>
            <td class="num"><strong>${formatTokens(comparison.totals.colony_tokens)}</strong></td>
            <td class="num savings-cell"><strong>${comparison.totals.savings_pct}%</strong></td>
            <td></td>
          </tr>
        </tfoot>
      </table>
      ${raw(unmatched)}
      ${raw(savingsTableStyle)}
    </div>`;
}

function renderUnmatchedComparisonSummary(comparison: SavingsLiveComparison): string {
  if (comparison.totals.unmatched_calls === 0) return '';
  const operations = comparison.unmatched_operations
    .slice(0, 8)
    .map((row) => `${row.operation}:${row.calls}`)
    .join(', ');
  const suffix =
    comparison.unmatched_operations.length > 8
      ? `, +${comparison.unmatched_operations.length - 8} more`
      : '';
  return html`
    <p class="meta">
      Unmatched live operations: ${comparison.totals.unmatched_calls} calls,
      ${formatTokens(comparison.totals.unmatched_colony_tokens)} tokens
      (<code>${operations}${suffix}</code>).
    </p>`;
}

function renderLiveTable(agg: McpMetricsAggregate, windowHours: number): string {
  if (agg.totals.calls === 0) {
    return html`
      <div class="card">
        <h2>Live: mcp_metrics (last ${windowHours}h)</h2>
        <p class="meta">
          No calls recorded yet. The colony MCP server records receipts on every wrapped tool
          call; once agents start coordinating through colony, rows show up here.
        </p>
      </div>`;
  }
  const rows = agg.operations.map((row) => renderLiveRow(row, agg.cost_basis)).join('');
  const sessions = renderLiveSessions(agg);
  return html`
    <div class="card">
      <h2>Live: mcp_metrics (last ${windowHours}h)</h2>
      <p class="meta">
        Per-operation token usage measured at the MCP boundary. ${costBasisText(
          agg.cost_basis,
        )} err = handler throws or MCP <code>isError</code>.
      </p>
      <table class="savings-table">
        <thead>
          <tr>
            <th>Operation</th>
            <th class="num">Calls</th>
            <th class="num">Err</th>
            <th class="num">Tokens in</th>
            <th class="num">Tokens out</th>
            <th class="num">Cost</th>
            <th class="num">Avg cost</th>
            <th class="num">Avg ms</th>
          </tr>
        </thead>
        <tbody>${raw(rows)}</tbody>
        <tfoot>
          <tr>
            <td><strong>Total</strong></td>
            <td class="num"><strong>${agg.totals.calls}</strong></td>
            <td class="num">${formatErr(agg.totals.error_count)}</td>
            <td class="num"><strong>${formatTokens(agg.totals.input_tokens)}</strong></td>
            <td class="num"><strong>${formatTokens(agg.totals.output_tokens)}</strong></td>
            <td class="num"><strong>${formatUsd(agg.totals.total_cost_usd, agg.cost_basis.configured)}</strong></td>
            <td class="num">${formatUsd(agg.totals.avg_cost_usd, agg.cost_basis.configured)}</td>
            <td class="num">${agg.totals.avg_duration_ms}</td>
          </tr>
        </tfoot>
      </table>
      ${raw(sessions)}
      ${raw(savingsTableStyle)}
    </div>`;
}

function renderLiveSessions(agg: McpMetricsAggregate): string {
  if (agg.session_summary.session_count === 0) return '';
  const rows = agg.sessions.map((row) => renderLiveSessionRow(row, agg.cost_basis)).join('');
  const truncation = agg.session_summary.sessions_truncated
    ? ` showing ${agg.sessions.length}`
    : '';
  return html`
    <h3>Live sessions</h3>
    <p class="meta">
      ${agg.session_summary.session_count} sessions with receipts${truncation};
      avg/session ${agg.session_summary.avg_calls} calls,
      ${formatTokens(agg.session_summary.avg_total_tokens)} tokens,
      ${formatUsd(agg.session_summary.avg_total_cost_usd, agg.cost_basis.configured)}.
    </p>
    <table class="savings-table">
      <thead>
        <tr>
          <th>Session</th>
          <th class="num">Calls</th>
          <th class="num">Err</th>
          <th class="num">Tokens in</th>
          <th class="num">Tokens out</th>
          <th class="num">Total</th>
          <th class="num">Cost</th>
        </tr>
      </thead>
      <tbody>${raw(rows)}</tbody>
    </table>`;
}

function renderLiveRow(
  row: McpMetricsAggregateRow,
  costBasis: McpMetricsAggregate['cost_basis'],
): string {
  return html`
    <tr>
      <td><code>${row.operation}</code></td>
      <td class="num">${row.calls}</td>
      <td class="num">${raw(formatErr(row.error_count))}</td>
      <td class="num">${formatTokens(row.input_tokens)}</td>
      <td class="num">${formatTokens(row.output_tokens)}</td>
      <td class="num">${formatUsd(row.total_cost_usd, costBasis.configured)}</td>
      <td class="num">${formatUsd(row.avg_cost_usd, costBasis.configured)}</td>
      <td class="num">${row.avg_duration_ms}</td>
    </tr>`;
}

function renderLiveSessionRow(
  row: McpMetricsAggregate['sessions'][number],
  costBasis: McpMetricsAggregate['cost_basis'],
): string {
  return html`
    <tr>
      <td><code>${formatSessionId(row.session_id)}</code></td>
      <td class="num">${row.calls}</td>
      <td class="num">${raw(formatErr(row.error_count))}</td>
      <td class="num">${formatTokens(row.input_tokens)}</td>
      <td class="num">${formatTokens(row.output_tokens)}</td>
      <td class="num">${formatTokens(row.total_tokens)}</td>
      <td class="num">${formatUsd(row.total_cost_usd, costBasis.configured)}</td>
    </tr>`;
}

function costBasisText(costBasis: McpMetricsAggregate['cost_basis']): string {
  if (!costBasis.configured) {
    return 'Cost rates are not configured; pass query params input_usd_per_1m/output_usd_per_1m or set env rates.';
  }
  return `Cost uses USD rates in=${formatRate(
    costBasis.input_usd_per_1m_tokens,
  )}/1M, out=${formatRate(costBasis.output_usd_per_1m_tokens)}/1M.`;
}

function formatErr(count: number): string {
  if (count <= 0) return '0';
  return `<span class="err-cell">${count}</span>`;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatSessionId(value: string): string {
  if (value.length <= 22) return value;
  return `${value.slice(0, 10)}...${value.slice(-9)}`;
}

function formatRate(value: number): string {
  if (value === 0) return '$0';
  return `$${value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
}

function formatUsd(value: number, configured: boolean): string {
  if (!configured) return '-';
  if (value === 0) return '$0';
  if (value < 0.000001) return '<$0.000001';
  if (value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

const savingsTableStyle = `
<style>
  .savings-table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
  .savings-table th, .savings-table td { padding: 6px 8px; border-bottom: 1px solid #1f2733; vertical-align: top; }
  .savings-table th { text-align: left; color: #8a94a3; font-weight: 600; }
  .savings-table td.num, .savings-table th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .savings-table tfoot td { border-top: 1px solid #2c3a52; border-bottom: 0; padding-top: 10px; }
  .savings-table .savings-cell { color: #8bd5a6; font-weight: 600; }
  .savings-table .err-cell { color: #fca5a5; font-weight: 600; }
  .savings-table tbody tr:hover { background: #11161e; }
  .receipt-value { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; }
  .receipt-value strong { color: #8bd5a6; font-size: 22px; }
  .receipt-value span { color: #8a94a3; }
</style>
`;
