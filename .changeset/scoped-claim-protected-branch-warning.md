---
"@colony/core": patch
---

`guardedClaimFile` now attaches a `protected_branch` warning to its `GuardedClaimResult` when the task lives on a protected base branch (`main`, `master`, `dev`, `develop`, `production`, `release`). Soft signal only — the claim is still recorded so sessions that lawfully resume an existing `main`-bound task aren't broken — but downstream callers (MCP, hooks, CLI) can now surface the worktree-discipline violation before it shows up on the health dashboard as a same-branch duplicate-owner contention. Uses the new `isProtectedBranch` helper exported from `@colony/storage` so all coordination layers share one definition.
