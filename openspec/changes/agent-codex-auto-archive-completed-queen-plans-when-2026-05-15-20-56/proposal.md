## Why

Completed Queen plans with `auto_archive=false` defer archival for a short
grace window. The completion path returned `auto_archive grace period pending`,
but without a later `task_plan_list` call the plan could remain completed and
unarchived until health surfaced a recommendation.

## What Changes

Schedule a bounded retry when the final sub-task completion hits the grace
window. The retry reuses the existing three-way archive path, records the normal
`plan-archived` / `plan-archive-blocked` / `plan-archive-error` observations,
and dedupes timers per store + plan.

## Impact

Affected surface is MCP plan completion. Existing `task_plan_list` sweep remains
as a fallback. Timers are unref'd and best-effort, so explicit list/completion
paths can still retry after process restarts.
