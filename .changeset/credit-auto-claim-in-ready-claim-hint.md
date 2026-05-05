---
"@imdeadpool/colony-cli": patch
---

`colony health` no longer flags the `task_ready_for_agent -> claim` conversion as bad when the dashboard's auto_claim signature is present. `task_ready_for_agent` defaulted to `auto_claim=true` in PR #402, so the server claims the unambiguous ready sub-task in the same MCP call without an explicit follow-up `task_plan_claim_subtask` invocation. The conversion metric only counts `tool_use` observations, so it reads near-zero on every health run even though sub-tasks are getting claimed. New gate: when `from_calls > 0`, `to_calls === 0`, and `ready_to_claim_vs_claimed.claimed > 0`, the hint is suppressed because the auto_claim path is doing the work silently. The conversion number itself is unchanged — only the false-positive hint goes away.
