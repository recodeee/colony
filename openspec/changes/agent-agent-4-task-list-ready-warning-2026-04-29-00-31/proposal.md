## Why

Agents are still using `task_list` as a scheduler instead of moving to `task_ready_for_agent`. The inventory tool needs to route callers at the response level, not only through descriptions and docs.

## What Changes

- Add top-level `coordination_warning` to `task_list` responses.
- Add top-level `next_tool: "task_ready_for_agent"` to `task_list` responses.
- Strengthen the warning after repeated same-session `task_list` calls without a `task_ready_for_agent` call.
- Keep `tasks` and the legacy `hint` field intact.

## Impact

Agents can still browse task inventory, but every response tells them that work selection belongs in `task_ready_for_agent`.
