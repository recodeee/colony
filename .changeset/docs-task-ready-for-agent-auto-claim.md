---
"@imdeadpool/colony-cli": patch
---

`docs/mcp.md` `task_ready_for_agent` entry now documents `auto_claim` (defaulted to `true` since PR #402): the server claims the unambiguous ready sub-task in the same MCP call and returns `auto_claimed: { ok, plan_slug, subtask_index, task_id, branch, file_scope }` plus a `next_action` pointing at `task_claim_file`. Also notes that the dashboard's `task_ready_for_agent -> task_plan_claim_subtask` conversion metric reads near-zero in normal operation because the loop closes inside one MCP call, and that `colony health` suppresses the false-positive hint when the auto-claim signature is detected (PR #424).
