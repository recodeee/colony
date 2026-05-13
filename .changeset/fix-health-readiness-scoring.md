---
"colonyq": patch
"@colony/storage": patch
---

Fix two `colony health` scoring bugs that surfaced as "bad" readiness areas with no real defect:

- **`colony_mcp_share.mcp_tool_calls = 0` despite live MCP traffic.** The counter only read `tool_calls` rows, missing MCP traffic when the calling agent's PostToolUse hook didn't fire for `mcp__*` tools. The counter now takes the max of that observed count and `mcp_metrics` row count (colony MCP server's own per-call receipt), with the source surfaced in `source_breakdown.colony_mcp_metrics`. New storage helper `countMcpMetricsSince(since, until?)`.
- **`claim_before_edit_ratio = null` when any edits lacked file_path metadata.** Forcing the ratio to null whenever `edit_tool_calls !== edits_with_file_path` turned a real 200/363 = 55% signal into a bare `n/a` headline. The ratio is now computed over measurable edits whenever `edits_with_file_path > 0`; the `status` field still communicates partial measurability for downstream consumers.
