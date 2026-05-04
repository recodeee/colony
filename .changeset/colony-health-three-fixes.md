---
"@colony/storage": patch
"@colony/mcp-server": patch
---

Three colony-health fixes:

- `claimBeforeEditStats` now strips the managed agent-worktree prefix (`.omx/agent-worktrees/<lane>/` and `.omc/agent-worktrees/<lane>/`) when comparing edit and claim file paths. Edits recorded inside a worktree now line up with claims posted on canonical repo-relative paths, so the claim-before-edit metric stops reporting `path_mismatch` for the same logical file.
- `task_ready_for_agent` accepts a new opt-in `auto_claim` boolean. When set, the server claims the unambiguous ready sub-task in the same call and reports the outcome as `auto_claimed` so harnesses no longer have to call `task_plan_claim_subtask` as a follow-up. Skips the auto-claim when the candidate is routed to a different agent or when no claimable work is ready.
- The plan auto-archive sweep now reconciles plans whose change directory was already moved to `openspec/changes/archive/<date>-<slug>/` on disk: it records a `plan-archived` observation referencing the archive path instead of looping forever as completed-but-unarchived. The sweep also strips a deleted agent-worktree segment from the parent task's `repo_root` before opening `SpecRepository`, so plans whose lane was pruned still archive cleanly.
