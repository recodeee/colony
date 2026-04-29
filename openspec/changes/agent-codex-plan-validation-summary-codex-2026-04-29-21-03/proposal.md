# Add plan validation summary before publish

## Problem

Queen and task plan publication can pass structural Colony validation while still being operationally weak. Plans need to surface stale blockers, dirty worktrees, missing MCP capability, quota-risk runtime hints, OMX note conflicts, protected-file policy gaps, and existing claims before agents begin claiming work.

## Solution

Add a deterministic `PlanValidationSummary` to the MCP validation and publish path. Keep findings severity-based (`error`, `warning`, `info`) so only hard capability gaps become blocking metadata while normal coordination risks stay visible without making planning unusably strict.

## Safety

Unit tests inject fixtures for worktree/MCP/runtime state. The production path may inspect the local managed-worktree report, but tests avoid shelling out directly.
