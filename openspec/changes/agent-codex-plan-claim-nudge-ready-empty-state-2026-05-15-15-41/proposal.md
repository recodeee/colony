## Why

`task_ready_for_agent` can return an empty ready queue while published plan work still exists behind blockers. The current empty state tells agents there is no claimable work, but it does not preserve the exact follow-up claim call for the next unclaimed sub-task.

## What Changes

- Add an optional `hint` field to empty `task_ready_for_agent` responses when an unclaimed published-plan sub-task exists.
- Include the plan slug, sub-task index, title, blocker metadata, exact `task_plan_claim_subtask` args, and Codex MCP call string.
- Keep existing `ready`, `empty_state`, `next_action`, and claimable-ready behavior unchanged.

## Impact

This is additive response metadata for the MCP ready queue. Existing callers that ignore unknown fields continue to work, while agents that render empty states can now surface plan-claim recovery context.
