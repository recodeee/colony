---
slug: gain-drift-detector-2026-05-16
---

# CHANGE · gain-drift-detector-2026-05-16

## §P  proposal
# Long-run tokens-per-call drift detector

## Problem

README §v0.x "Receipts and observability" calls out a missing long-run
regression detector for tool token spend. Operators today can spot a single
hot loop with `colony gain`, but they cannot answer "did `search` quietly
get 40% more expensive in the last three days?" without manually charting
the daily aggregates. We need a deterministic signal that fires when a
tool's median tokens-per-call drifts outside a configurable band against a
baseline window.

## Acceptance criteria

- `colony gain drift` ships with sensible defaults
  (`--baseline-days 14 --recent-days 3 --min-calls 20 --threshold 1.25
  --down-threshold 0.75`) and a `--json` mode whose payload includes window
  bounds, classified rows, and `new_tools` / `gone_tools` / `insufficient_data`
  arrays.
- `savings_drift_report` MCP tool exposes the same surface, named so it
  groups with `savings_report` and does not collide with the existing
  `task_drift_check` (file-edit drift).
- No schema change. The signal reads `mcp_metrics` only.
- Windows are non-overlapping with a 3-day gap so day-of-week noise does
  not bleed across baseline and recent.
- Only `ok=1` receipts contribute; retry storms cannot inflate the median.
- A baseline-shorter-than-history warning appears in both CLI and MCP
  outputs.
- Storage method, classifier, CLI render, MCP envelope, and listed-tools
  set are covered by focused tests.

## Sub-tasks

### Sub-task 0: Implement and verify

File scope: packages/storage/src/storage.ts, packages/core/src/drift.ts,
packages/core/src/index.ts, apps/cli/src/commands/gain.ts,
apps/mcp-server/src/tools/savings-drift.ts, apps/mcp-server/src/server.ts,
docs/mcp.md, packages/storage/test/mcp-metrics.test.ts,
apps/cli/test/gain-drift.test.ts, apps/mcp-server/test/server.test.ts.

Verification: `pnpm --filter @colony/storage test`,
`pnpm --filter colonyq typecheck`, `pnpm --filter colonyq test -- gain`,
`pnpm --filter @colony/mcp-server test`, `pnpm --filter colonyq build`.

## §S  delta
op|target|row
-|-|-

## §T  tasks
id|status|task|cites
-|-|-|-

## §B  bugs
id|status|task|cites
-|-|-|-
