---
'colonyq': minor
'@colony/storage': minor
---

`colony gain --summary` now renders an rtk-style compact view over the same
`mcp_metrics` receipts: headline KPI stack (total calls, input/output/total
tokens, tokens saved, total exec time), efficiency meter, top-N **By
Operation** table with proportional impact bars, a 30-day **Daily Activity**
bar graph, and a 12-day **Daily Breakdown** table. `--graph` and `--daily`
narrow the output to a single section; `--days <n>` and `--top-ops <n>` tune
the window and table size. Per-operation saved-token credit is distributed
across each comparison row's `matched_operations` proportionally to call share
so the `Saved` column lines up with the headline total.

Storage gains `Storage.aggregateMcpMetricsDaily({ since, until, operation })`
returning per-UTC-day rollups (`{ day, calls, input_tokens, output_tokens,
total_tokens, total_duration_ms }`) ordered newest-first. Type exports
`AggregateMcpMetricsDailyOptions` and `McpMetricsDailyRow` come along.
