---
"@colony/mcp-server": minor
"@colony/hooks": minor
---

Surface a `claim_required: true` flag on `task_ready_for_agent` whenever
the response carries a claimable plan sub-task or quota-relay handoff
that the calling agent should follow up on with
`task_plan_claim_subtask` (or `task_claim_quota_accept`). Loop adoption
sat at 0% across sessions because the queue response only carried a
hint inside `next_action`; agents that stopped reading at the result
shape skipped the claim. The new boolean lets clients gate work
selection on the explicit signal.

SessionStart now appends a one-line `## Ready Queen sub-tasks` preface
when the active repo has unclaimed plan sub-tasks, listing the count
and reminding the agent to follow `task_ready_for_agent` with
`task_plan_claim_subtask`. The nudge is silent when no cwd is detected,
no real `(repo_root, branch)` resolves, or no plan has unclaimed work.
