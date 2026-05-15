---
'colonyq': minor
'@colony/storage': minor
'@colony/core': minor
'@colony/mcp-server': minor
---

`colony gain drift` and a matching `savings_drift_report` MCP tool flag
tools whose median tokens-per-call has drifted up or down. Default windows
are non-overlapping: recent = last 3 days, baseline = 14 days ending 3 days
before recent. Default thresholds: `--threshold 1.25` (up), `--down-threshold
0.75`, `--min-calls 20` per window. Classifications: `up_drift`,
`down_drift`, `new_tool` (no baseline), `gone` (no recent), `insufficient_data`,
`stable`.

Storage gains `Storage.mcpTokenDriftPerOperation()` which computes per-operation
medians with a `ROW_NUMBER() OVER (PARTITION BY operation ORDER BY tpc)`
window function — chosen over the correlated `LIMIT 1 OFFSET (COUNT-1)/2`
form because SQLite forbids outer aggregate references in scalar-subquery
`OFFSET`. A `mcpMetricsMinTs()` helper surfaces a one-line warning when the
baseline window starts before the first recorded metric.
