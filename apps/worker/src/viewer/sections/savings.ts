import {
  type SavingsReferenceRow,
  SAVINGS_REFERENCE_ROWS,
  savingsReferenceTotals,
} from '@colony/core';
import type { McpMetricsAggregate, McpMetricsAggregateRow } from '@colony/storage';
import { html, layout, raw } from '../html.js';

export interface SavingsPagePayload {
  live: McpMetricsAggregate;
  windowHours: number;
}

export function renderSavingsPage(payload: SavingsPagePayload): string {
  const referenceTotals = savingsReferenceTotals();
  const reference = renderReferenceTable(SAVINGS_REFERENCE_ROWS, referenceTotals);
  const live = renderLiveTable(payload.live, payload.windowHours);
  const body = html`
    <p><a href="/">&larr; back to sessions</a></p>
    <h2>Token savings</h2>
    <p class="meta">
      Two views: hand-authored reference rows that estimate cost with vs. without colony, and
      live <code>mcp_metrics</code> receipts recorded by the wrapping MCP handler. Token counts
      use <code>@colony/compress#countTokens</code>, the same primitive as observation receipts.
    </p>
    ${raw(reference)}
    ${raw(live)}
  `;
  return layout('agents-hivemind · savings', body);
}

function renderReferenceTable(
  rows: ReadonlyArray<SavingsReferenceRow>,
  totals: ReturnType<typeof savingsReferenceTotals>,
): string {
  const body = rows
    .map(
      (row) => html`
        <tr>
          <td><strong>${row.operation}</strong><div class="meta">${row.rationale}</div></td>
          <td class="num">${row.frequency_per_session}x</td>
          <td class="num">${formatTokens(row.baseline_tokens)}</td>
          <td class="num">${formatTokens(row.colony_tokens)}</td>
          <td class="num savings-cell">${row.savings_pct}%</td>
        </tr>`,
    )
    .join('');
  return html`
    <div class="card">
      <h2>Reference: standard vs. colony</h2>
      <p class="meta">
        Per-session token estimates for common dev-loop operations. Source:
        <code>packages/core/src/savings-reference.ts</code>.
      </p>
      <table class="savings-table">
        <thead>
          <tr>
            <th>Operation</th>
            <th class="num">Freq</th>
            <th class="num">Standard</th>
            <th class="num">Colony</th>
            <th class="num">Saved</th>
          </tr>
        </thead>
        <tbody>${raw(body)}</tbody>
        <tfoot>
          <tr>
            <td><strong>Total / session</strong></td>
            <td></td>
            <td class="num">${formatTokens(totals.baseline_tokens)}</td>
            <td class="num">${formatTokens(totals.colony_tokens)}</td>
            <td class="num savings-cell"><strong>${totals.savings_pct}%</strong></td>
          </tr>
        </tfoot>
      </table>
      ${raw(savingsTableStyle)}
    </div>`;
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
  const rows = agg.operations.map(renderLiveRow).join('');
  return html`
    <div class="card">
      <h2>Live: mcp_metrics (last ${windowHours}h)</h2>
      <p class="meta">
        Per-operation token usage measured at the MCP boundary. err = handler throws.
      </p>
      <table class="savings-table">
        <thead>
          <tr>
            <th>Operation</th>
            <th class="num">Calls</th>
            <th class="num">Err</th>
            <th class="num">Tokens in</th>
            <th class="num">Tokens out</th>
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
            <td class="num">${agg.totals.avg_duration_ms}</td>
          </tr>
        </tfoot>
      </table>
    </div>`;
}

function renderLiveRow(row: McpMetricsAggregateRow): string {
  return html`
    <tr>
      <td><code>${row.operation}</code></td>
      <td class="num">${row.calls}</td>
      <td class="num">${raw(formatErr(row.error_count))}</td>
      <td class="num">${formatTokens(row.input_tokens)}</td>
      <td class="num">${formatTokens(row.output_tokens)}</td>
      <td class="num">${row.avg_duration_ms}</td>
    </tr>`;
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
</style>
`;
