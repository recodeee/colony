---
'@colony/core': patch
'@colony/mcp-server': patch
---

Reject `task_claim_file` at the MCP layer when the task's branch is a protected base branch.

`guardedClaimFile` already returned `protected_branch_rejected` (controlled by the `rejectProtectedBranchClaims` setting, default `true`) but the MCP handler silently fell through and recorded the claim anyway. The handler now checks for that status and returns a distinct `PROTECTED_BRANCH_CLAIM_REJECTED` error code with a message directing the agent to start a sandbox worktree first.

`PROTECTED_BRANCH_CLAIM_REJECTED` is added to `TASK_THREAD_ERROR_CODES` in `@colony/core`. Two new integration tests cover the reject and allow cases.

Note: the same `guardedClaimFile` call in `task_plan_claim_subtask` has the same gap; that is out of scope for this patch.
