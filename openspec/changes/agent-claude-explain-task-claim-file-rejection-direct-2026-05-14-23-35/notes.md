# agent-claude-explain-task-claim-file-rejection-direct-2026-05-14-23-35 (minimal / T1)

Branch: `agent/claude/explain-task-claim-file-rejection-direct-2026-05-14-23-35`

`task_claim_file` (MCP) and `TaskThread.claimFile` /
`normalizeOptionalClaimPath` (core) now classify the rejection branch of
`normalizeTaskFilePath` and render a specific user-facing message per
reason: directory, pseudo, outside_repo, empty, or unknown (legacy
fallback). The 5 `INVALID_CLAIM_PATH: file path is not claimable:
colony/packages/core/test` errors visible in `colony gain` are exactly the
"directory" branch — the message now tells the agent to claim individual
files instead of bouncing off the same input.

Shared primitives live in `@colony/storage` so the MCP tool and TaskThread
both consume the same `claimPathRejectionMessage()` and reason enum.
Behavior unchanged; only the message text + new optional classifier export
are introduced.

## Handoff

- Handoff: change=`agent-claude-explain-task-claim-file-rejection-direct-2026-05-14-23-35`; branch=`agent/claude/explain-task-claim-file-rejection-direct-2026-05-14-23-35`; scope=`packages/storage + packages/core + apps/mcp-server`; action=`finish via PR after user sign-off`.

## Cleanup

- [ ] Run: `gx branch finish --branch agent/claude/explain-task-claim-file-rejection-direct-2026-05-14-23-35 --base main --via-pr --wait-for-merge --cleanup`
- [ ] Record PR URL + `MERGED` state in the completion handoff.
- [ ] Confirm sandbox worktree is gone (`git worktree list`, `git branch -a`).
