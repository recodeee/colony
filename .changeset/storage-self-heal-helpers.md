---
"@colony/storage": patch
---

Wave 1 storage self-heal helpers — additive only:

- `Storage.sweepStaleClaims({ stale_after_ms, now?, limit? })` bulk-demotes `state='active'` claims older than the cutoff to `state='weak_expired'` and returns the demoted rows. The attention_inbox already surfaces stale claims as a cleanup signal, but until something actually demotes them they keep blocking other agents who treat any 'active' row as live ownership. Pure data update; callers emit `claim-weakened` observations themselves if they want the demotion to surface in timelines.
- `Storage.findCompletedQueenPlans(repo_root?)` returns queen-plan candidates whose every `spec/<slug>/sub-N` row has its latest `plan-subtask-claim` observation in `metadata.status='completed'` and whose parent `spec/<slug>` row isn't archived. The MCP plan tool's read-path sweep only fires for plans with `auto_archive=true`; this scan exposes the same candidate set so non-MCP callers (CLI, periodic sweep, autopilot) can archive them via `archiveQueenPlan` without the per-plan opt-in.
- `isProtectedBranch(branch)` and the exported `PROTECTED_BRANCH_NAMES` set codify the worktree-discipline rule that protected base branches (`main`, `master`, `dev`, `develop`, `production`, `release`) should never carry agent file claims directly. Hooks, MCP, and CLI can share one definition instead of drifting copies.
