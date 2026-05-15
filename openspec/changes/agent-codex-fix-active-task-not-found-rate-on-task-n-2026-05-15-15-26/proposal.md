## Why

`colony gain` shows `task_note_working` failing with `ACTIVE_TASK_NOT_FOUND`
for fresh MCP sessions that pass a concrete `repo_root` and `branch` but have
not joined a task yet. This makes a working-state write look like a hard
coordination failure even though Colony has enough scope to create or join the
branch task.

## What Changes

- When `task_note_working` finds no active task and the caller supplied both
  `repo_root` and `branch`, create or join the Colony task for that pair.
- Join the caller session to that task, post the working note, and return a
  successful response marked `status: "task_materialized"`.
- Keep ambiguous active-task matches as errors, and keep OMX notepad fallback
  available only for explicit fallback cases where a branch task cannot be
  materialized.

## Impact

- Reduces `ACTIVE_TASK_NOT_FOUND` telemetry for normal fresh-session working
  note calls.
- May create a task row for a branch when a caller supplies explicit scope.
- Focused tests cover both existing-branch join and new branch-task creation.
