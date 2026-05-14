---
'@colony/storage': patch
'colonyq': patch
---

Fix `aggregateMcpMetrics` error_reasons grouping so per-row counts sum to
`error_count`. The grouping previously partitioned by `(operation, error_code,
error_message)`, but several handlers embed unique session IDs in their error
messages (e.g. `sub-task is claimed by codex-session-XYZ`), so each race loss
produced a distinct group. Combined with a 3-row truncation per operation, the
result was that nearly all errors were hidden — `task_plan_claim_subtask` would
report 7 errors in the Top error reasons table while the Operations table showed
93 for the same row. Grouping now drops `error_message` from the key (SQLite
picks the row with the latest `ts` for the sample message via its bare-column-
with-MAX optimization) and the per-operation cap is bumped from 3 to 8 since
codes are low-cardinality. Sum-of-reasons now matches error_count exactly.
