## ADDED Requirements

### Requirement: `colony gain --summary` renders an rtk-style compact view
The CLI SHALL accept `--summary`, `--graph`, `--daily`, `--days <n>`, and
`--top-ops <n>` on the `gain` subcommand and route to a compact renderer
sourced from `mcp_metrics` receipts when any of `--summary`, `--graph`, or
`--daily` is present.

#### Scenario: Default summary view
- **WHEN** the user runs `colony gain --summary`
- **THEN** the renderer prints (in order) a one-line header
  `Colony Token Savings (last <window>)`, a heavy rule, an aligned KPI block
  (`Total calls`, `Input tokens`, `Output tokens`, `Total tokens`,
  `Tokens saved`, `Total exec time`, `Efficiency meter`), the **By Operation**
  table (top-N rows ordered by attributed saved tokens descending, each with a
  proportional impact bar), the **Daily Activity** bar graph over the
  trailing `--days` window (default 30), and the **Daily Breakdown** table for
  up to the last 12 days
- **AND** an empty window produces the message `No mcp_metrics receipts in
  window. Register the colony MCP server or run agents that call its tools to
  populate.`

#### Scenario: Graph-only and daily-only outputs
- **WHEN** the user runs `colony gain --graph`
- **THEN** only the **Daily Activity** section is emitted, with no headline or
  breakdown
- **WHEN** the user runs `colony gain --daily`
- **THEN** only the **Daily Breakdown** section is emitted, with no headline or
  graph

#### Scenario: JSON payload carries the daily rollup
- **WHEN** the user runs `colony gain --summary --json`
- **THEN** the JSON payload retains the existing `live.{totals, operations,
  sessions, ...}` shape and additionally carries `live.daily` as an array of
  `{ day, calls, input_tokens, output_tokens, total_tokens, total_duration_ms }`
  rows newest-day-first.

#### Scenario: Saved tokens attribution
- **WHEN** the renderer computes per-row `Saved` for the **By Operation** table
- **THEN** the comparison row's `baseline_tokens - colony_tokens` SHALL be
  distributed across that row's `matched_operations` proportionally to each
  matched live operation's share of the row's calls
- **AND** when no comparison row matches a live operation, the per-row `Saved`
  cell renders as `—` and the impact bar falls back to the row's share of
  total token spend
- **AND** the headline `Tokens saved` SHALL equal the comparison's
  `totals.baseline_tokens - totals.colony_tokens`, so per-row saved values
  reconcile to the headline.

### Requirement: `Storage.aggregateMcpMetricsDaily` exposes a UTC-day rollup
The storage package SHALL expose `Storage.aggregateMcpMetricsDaily(opts)`
returning per-UTC-day rollups for the `colony gain --summary` view and any
downstream tooling.

#### Scenario: Groups by UTC calendar day newest-first
- **WHEN** the caller invokes `aggregateMcpMetricsDaily({ since, until })`
- **THEN** the result SHALL include one row per UTC calendar day with at least
  one matching receipt, with fields
  `{ day: 'YYYY-MM-DD', calls, input_tokens, output_tokens, total_tokens,
  total_duration_ms }` ordered newest-day-first
- **AND** receipts whose `ts` falls on the same UTC day SHALL collapse into a
  single row regardless of UTC offset within that day.

#### Scenario: Honors window and operation filters
- **WHEN** the caller passes `since`/`until`
- **THEN** only receipts with `ts` in `[since, until]` SHALL contribute to the
  result
- **WHEN** the caller passes `operation`
- **THEN** only receipts whose `operation` exactly matches SHALL contribute.

#### Scenario: Empty window is safe
- **WHEN** the window contains zero receipts
- **THEN** the call SHALL return `[]` without throwing.
