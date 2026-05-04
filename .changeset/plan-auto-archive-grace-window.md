---
"@colony/mcp-server": minor
---

Auto-archive completed Queen plans after a 60-second grace window, even
when the plan was published with `auto_archive: false`. Previously, plans
without explicit opt-in lingered forever after their last sub-task
completed, leaving `queen_plan_readiness` red and forcing operators to
run `colony plan close` by hand.

`runAutoArchiveIfReady` now compares the latest `plan-subtask-claim`
completion timestamp against an `AUTO_ARCHIVE_GRACE_PERIOD_MS` constant
(60 seconds). Within the window the call still returns `skipped` with
reason `auto_archive grace period pending`, giving the lane time to
land a manual close or reject the archive entirely. Past the window the
three-way merge runs and the change is moved to
`openspec/changes/archive/<date>-<slug>` as before.

`task_plan_list` now triggers an opportunistic sweep over completed
plans before returning, so health/agents that read plans drive the
archive without a daemon. Conflicts and errors continue to surface as
`plan-archive-blocked` / `plan-archive-error` observations on the
parent spec task instead of failing the list call.
