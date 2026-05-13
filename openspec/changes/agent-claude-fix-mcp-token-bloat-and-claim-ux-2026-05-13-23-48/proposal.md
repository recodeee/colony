## Why

`colony gain --window=168h` shows three MCP error/spend patterns dominating the surface:

1. `task_plan_list` consumes ~60% of all MCP wire tokens (335k tokens across 26 calls — 12.9k avg/call). It returns the full `PlanInfo` shape including every `subtasks[].description` and `subtasks[].file_scope`, which the typical "is there work for me" caller does not need.
2. `task_note_working` errors 8× with `ACTIVE_TASK_NOT_FOUND` and zero candidates — a fresh agent session that has not joined the active task on its branch gets nothing back to recover with.
3. `task_plan_claim_subtask` fails ~39% of the time (13 of 33) with `PLAN_SUBTASK_NOT_AVAILABLE`. The error message tells the caller *why* but not *which sub-task to retry*, forcing a follow-up `task_plan_list` round trip (~12.9k tokens) to find one.

These are the three readiness signals colony itself can move without changing agent behavior.

## What Changes

1. **`task_plan_list` compact default.** Add `detail: 'compact' | 'full'` (default `'compact'`). Compact returns `subtask_counts`, `subtask_count`, `subtask_indexes`, `next_available_count`, and `next_available: [{ subtask_index, title, status, capability_hint, wave_index, blocked_by_count, claimed_by_session_id }]`. Full returns the legacy shape unchanged. Internal `listPlans()` callers in `@colony/core` are untouched.
2. **`task_note_working` nearby tasks.** When `ACTIVE_TASK_NOT_FOUND` and either `repo_root` or `branch` was supplied, attach `nearby_tasks` (branch-and-repo > branch-only > repo-only match-rank) plus a `hint` pointing at `task_post(task_id=...)` / `task_accept_handoff` so the caller can recover without re-listing tasks. Does not auto-bind — the caller stays in control.
3. **`task_plan_claim_subtask` recovery hint.** When the failure code is `PLAN_SUBTASK_NOT_AVAILABLE`, attach `plan_slug`, `subtask_counts`, `next_available_count`, `next_available_subtask_index`, and a compact `next_available[]` list to the error payload so a racing claimer can retry without calling `task_plan_list`.

## Impact

- **Wire format change** on `task_plan_list`: callers reading `plans[].subtasks` against the default response now see `subtask_indexes` instead. Mitigation: pass `detail: 'full'` to preserve the legacy shape. Internal callers (CLI / worker / hook handlers) bypass MCP and are unaffected.
- **Error payload growth** on `task_plan_claim_subtask` (PLAN_SUBTASK_NOT_AVAILABLE only): adds a bounded list of available sub-tasks. Net token win because the alternative — a `task_plan_list` retry — is much larger.
- **No DB migration**, no behavior change for healthy callers.
- New tests: compact-shape contract (`task_plan_list`), recovery hint (`task_plan_claim_subtask`), nearby-tasks widening (`task_note_working`).
- Docs updated in `docs/mcp.md`.
