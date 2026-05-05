---
"@colony/core": patch
"@imdeadpool/colony-cli": patch
---

`buildCoordinationSweep` now accepts an `archive_completed_plans` option that scans for queen plans whose every sub-task's latest `plan-subtask-claim` observation is `metadata.status='completed'` and archives the parent + sub-task rows via `archiveQueenPlan`. The MCP plan-tool sweep only fires for plans with `auto_archive=true` in plan-config, so opt-out plans linger as "completed but unarchived" on the queen_plan_readiness health signal forever; this gives operators an explicit CLI-driven path to clear them. Sweep result gains `archived_completed_plans` (rows) and `summary.archived_completed_plan_count` (count). Idempotent — already-archived plans are not re-counted.

Exposed via `colony coordination sweep --archive-completed-plans` (skipped automatically when `--dry-run` is set, like the other release flags).
