## Why

- `task_plan_list` defaults to returning up to 50 plans, which makes routine
  MCP calls heavier than needed when the plan registry is large.
- Agents should still be able to request a larger page explicitly, but the
  default browse surface should stay compact.

## What Changes

- Lower the core `listPlans()` default limit from 50 to 10.
- Preserve the MCP `task_plan_list.limit` validation cap at 50.
- Add regression coverage that verifies the default returns 10 plans and an
  explicit `limit` can still return more.

## Impact

- Affected surfaces: Colony core plan listing and the MCP `task_plan_list`
  tool.
- Callers that need larger responses must pass `limit` explicitly.
- No schema or migration changes.
