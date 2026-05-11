## Why

- `colony health` can ingest Codex rollout MCP events for share metrics.
- The same rollout-source diagnostic was also showing up as a health/review note, even though it is not an actionable issue.

## What Changes

- Keep Codex rollout MCP events in the structured health payload.
- Stop printing the rollout-source diagnostic in human health output so snapshots do not surface it as a review note.
- Add focused regression coverage for the human output.

## Impact

- Affects CLI health text output only.
- JSON diagnostics still expose `colony_mcp_share.source_breakdown.codex_rollouts` for automation.
