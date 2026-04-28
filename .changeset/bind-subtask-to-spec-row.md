---
"@colony/core": minor
"@colony/mcp-server": minor
---

Bind plan sub-tasks to §V/§I/§T/§B rows in the parent SPEC.md so the
spec lane and plan lane share state instead of running side by side.

`@colony/core`:

- `SubtaskInfo` gains an optional `spec_row_id: string | null`. The
  field is read from `plan-subtask` observation metadata.

`@colony/mcp-server`:

- `task_plan_publish` accepts an optional `spec_row_id` per sub-task.
  Validated at publish time against the root SPEC.md — a typo'd row id
  fails fast with `PLAN_SPEC_ROW_NOT_FOUND` instead of silently
  no-opping at completion.
- `task_plan_complete_subtask` appends a `modify` delta to the parent
  change document when the sub-task carries a `spec_row_id`, flipping
  the row's status cell to `done`. The delta surfaces through the same
  three-way merge path the change archive already uses, so when the
  plan auto-archives, the bound rows roll over in the root spec
  automatically. Failures (missing row, unwritable change) record an
  observation but do not tear down the completion.
- New tool `task_plan_status_for_spec_row` answers "is anyone working
  on T7 right now?" by returning the bound plan slug, sub-task index,
  and current status (or null when no binding exists).
- `spec_read` now includes a `bound_subtasks` field — a map of spec
  row id → `{ plan_slug, subtask_index, status }` — so callers can
  spot in-flight rows without scanning every plan themselves.
