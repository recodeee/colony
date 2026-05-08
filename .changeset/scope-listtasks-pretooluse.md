---
'@colony/storage': patch
'@colony/hooks': patch
---

Stop scanning the full task table on every PreToolUse tool call

`protectedLiveClaimConflict` in the PreToolUse hook used `listTasks(1_000_000)` to find conflicting protected-branch claims and then linearly filtered the result by `repo_root` and `isProtectedBranch(branch)`. With the task table growing into the thousands across all agents, that scan dominated p95 latency on every editor tool call and violated the <150ms hook-handler budget.

`@colony/storage` now exposes `listProtectedBranchTasksByRepo(repoRoot)`, a single index-backed query against the existing `UNIQUE(repo_root, branch)` constraint. The PreToolUse hook calls this in place of the unbounded scan; defensive `resolve()` and `isProtectedBranch()` checks remain inside the loop so storage path inconsistencies still get filtered out. No new migration is needed — the unique index already covers the new query shape.
