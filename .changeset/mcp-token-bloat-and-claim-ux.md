---
'@colony/mcp-server': minor
---

Trim `task_plan_list` token bloat and add recovery hints to two error paths.

`task_plan_list` now defaults to a compact rollup that omits `subtasks[].description` and `subtasks[].file_scope` — the two heavy fields driving ~60% of MCP wire token spend (12.9k avg per call in `colony gain`). The full legacy shape is preserved as opt-in via `detail: 'full'`. Internal `listPlans()` callers in `@colony/core` bypass MCP and are unaffected.

`task_note_working` now returns `nearby_tasks` (ranked branch-and-repo > branch-only > repo-only) plus a recovery `hint` when `ACTIVE_TASK_NOT_FOUND` and the caller supplied a `repo_root` or `branch`. Fresh agent sessions that have not yet joined the active task on their branch can recover via `task_post(task_id=...)` or `task_accept_handoff` without re-listing the task table.

`task_plan_claim_subtask` now attaches `next_available_subtask_index`, `next_available_count`, and a compact `next_available[]` list to `PLAN_SUBTASK_NOT_AVAILABLE` errors so a racing claimer can retry immediately instead of issuing a full `task_plan_list` round trip.
