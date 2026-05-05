---
"@colony/storage": minor
"@colony/core": minor
"@colony/mcp-server": minor
"@colony/worker": minor
"@imdeadpool/colony-cli": minor
---

Add per-operation token instrumentation and a savings surface with three
entry points that share one data source:

- New `mcp_metrics` SQLite table records `(operation, ts, input_bytes,
  output_bytes, input_tokens, output_tokens, duration_ms, ok)` for every
  wrapped MCP tool call. Recording is best-effort: a write failure cannot
  break a tool call. Tokens are counted via `@colony/compress#countTokens`
  so values align with observation token receipts.
- `Storage.recordMcpMetric` and `Storage.aggregateMcpMetrics` expose the
  table; new types `NewMcpMetric`, `AggregateMcpMetricsOptions`,
  `McpMetricsAggregate`, and `McpMetricsAggregateRow` ship from
  `@colony/storage`.
- `apps/mcp-server` composes a metrics wrapper alongside the existing
  heartbeat wrapper. Heartbeat outer (touches active session before the
  handler), metrics inner (measures handler input/output around the actual
  work).
- New MCP tool `savings_report` returns hand-authored reference rows plus
  live per-operation usage. CLI `colony gain` renders the same data with
  optional `--hours`, `--since`, `--operation`, `--json` flags. Worker
  exposes `/savings` (HTML) and `/api/colony/savings` (JSON), reachable
  from the index page link.
- Hand-authored reference table lives in
  `packages/core/src/savings-reference.ts` so all three surfaces stay in
  sync from one source.
