## Why

`savings_report` already exposes per-operation `error_reasons`, but operators
who are diagnosing a noisy fleet need the inverse view: which error code is
dominant across all operations, and which operations contribute to that code.
Without that additive grouping, the caller has to fetch the whole live operation
array and recompute counts client-side.

## What Changes

- Add `live.error_breakdown` to `savings_report`.
- Group live mcp_metrics errors by `error_code`, preserving total count, latest
  timestamp, and top contributing operations.
- Keep the existing `live.operations[*].error_reasons` payload unchanged for
  compatibility.

## Impact

- Affected surface: `apps/mcp-server/src/tools/savings.ts`.
- The new field is additive JSON output and should not break existing clients.
- Operation lists under each error code are bounded to keep the MCP response
  compact.
