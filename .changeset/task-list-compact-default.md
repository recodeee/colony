---
'@colony/mcp-server': minor
---

`task_list` MCP tool now returns a compact rollup by default.

`colony gain` showed `task_list` averaging 14.1k tokens per call — the second-largest line item after the recently-trimmed `task_plan_list`. Each row was emitting the full `TaskRow` shape (8 fields including long `repo_root` absolute paths and long `agent/*` branch names) for up to 50 tasks per call.

Default response is now `tasks: [{ id, title, branch, status, updated_at }]`. The legacy shape including `repo_root`, `created_by`, and `created_at` is preserved as opt-in via `detail: "full"`. Internal callers using `store.storage.listTasks()` directly are unaffected.
