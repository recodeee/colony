## Why

`colony gain` already records every MCP tool call into `mcp_metrics` via the
metrics wrapper (input/output tokens, duration, ok/error, session, repo root),
so the telemetry capture path matches what `rtk` does with its `commands`
table. The default `colony gain` renderer focuses on the diagnostic view
(Operations table, Movers, Top error reasons, Live sessions, comparison
model). That view is good for triage but heavy; users coming from `rtk gain`
expect a one-screen "where did the tokens go" readout with proportional bars
and a daily timeline.

This change adds that compact view to the existing `colony gain` command
without changing the default output. The capture layer stays untouched; only a
new daily aggregator and a new renderer are added on top.

## What Changes

- `Storage.aggregateMcpMetricsDaily({ since, until, operation })` (new):
  UTC-day rollup over `mcp_metrics`, returning
  `{ day, calls, input_tokens, output_tokens, total_tokens, total_duration_ms }`
  rows newest-day-first. Type exports `AggregateMcpMetricsDailyOptions` and
  `McpMetricsDailyRow` from `@colony/storage`.
- `colony gain --summary` (new): rtk-style headline (total calls, input/output
  tokens, tokens saved, total exec time, efficiency meter), top-N **By
  Operation** table with proportional impact bars, **Daily Activity** bar
  graph, **Daily Breakdown** table.
- `colony gain --graph` / `--daily` (new): emit the graph or breakdown section
  alone — useful in pipelines and dashboards.
- `colony gain --days <n>` / `--top-ops <n>` (new): tune the daily window
  (default 30) and the top-ops cap in the table (default 10).
- `colony gain --summary --json` extends the existing JSON payload with a
  `live.daily` array for downstream tooling.
- Headline `Tokens saved` and the efficiency meter reuse the
  `savingsLiveComparison` reference model. The per-op `Saved` column
  distributes each comparison row's `baseline_tokens - colony_tokens` across
  its `matched_operations` proportionally to per-op call share, so the column
  values sum to the headline total.
- README documents the new flags with sample output.
- The existing `gain.test.ts` spy mocks now strip ANSI escapes from captured
  stdout before asserting, so the assertions hold whether kleur is in
  color-on (local TTY with `COLORTERM=truecolor`) or color-off (CI) mode.

## Impact

- **Surfaces touched.** `apps/cli/src/commands/gain.ts`, `apps/cli/test/gain.test.ts`,
  `packages/storage/src/storage.ts`, `packages/storage/src/types.ts`,
  `packages/storage/src/index.ts`, `packages/storage/test/mcp-metrics.test.ts`,
  `README.md`, plus a changeset under `.changeset/`.
- **Backward compatibility.** Additive only. No flag is removed or repurposed;
  the default `colony gain` view is byte-identical. No storage migration —
  the daily aggregator reads existing rows.
- **Performance.** Daily aggregator is a single grouped `SELECT` on
  `mcp_metrics` filtered by `(ts, operation)` indexes. The view fetches it
  only when `--summary` / `--graph` / `--daily` is passed.
- **Risk.** Low. Tests cover the storage aggregator (3 new cases), renderer
  helpers (`renderImpactBar`, `formatDurationMs`, `fillDailyWindow`), and the
  headline/graph/breakdown render paths (5 new cases). End-to-end run against
  a real local dev DB matches the rtk visual.
