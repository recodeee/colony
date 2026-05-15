---
'colonyq': minor
'@colony/storage': minor
---

`colony health --coach` walks a repo through first-week setup. It detects
adoption stage (`fresh` / `installed_no_signal` / `early` / `mid_adoption`)
from cheap signals (`countObservations`, installed-IDE flags,
`firstObservationTs`, `Math.max(toolCallsSince, countMcpMetricsSince)`),
then surfaces the NEXT incomplete step from a fixed 7-step ladder:
`install_runtime` → `first_task_post` → `first_task_claim_file` →
`first_task_hand_off` → `first_plan_claim` → `first_quota_release` →
`first_gain_review`. Each step carries an exact `cmd:` and `tool:` string.

Progress is persisted in a new `coach_progress` SQLite table (migration
`014-coach-progress.ts`, schema_version 13 → 14). Step completion is
event-observed via `mcp_metrics` / `observations`, never user-clicked.
`colony gain` records a `coach_gain_review` observation so step 7 can
self-detect. `--coach` is mutually exclusive with `--fix-plan` and respects
`--json`.
