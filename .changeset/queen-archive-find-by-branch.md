---
"@colony/storage": patch
"@imdeadpool/colony-cli": patch
---

`colony queen archive` now resolves the plan by branch directly via
`findTaskByBranch` instead of routing through `queenPlans()`. The queen
listing only surfaces plans with a `queen` participant, so orphan plans
published by codex/claude lanes (auto-plan-builder, ad-hoc spec lanes)
were rejected with `queen plan not found` even though their parent
task and sub-task rows existed in the DB. Add a public
`countClaimedQueenPlanSubtasks` helper so the CLI can keep its
`--force` safety check without reaching into the private `Storage.db`
handle.
