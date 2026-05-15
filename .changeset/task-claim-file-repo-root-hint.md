---
'@colony/storage': patch
'@colony/core': patch
'@colony/mcp-server': patch
---

`task_claim_file` now surfaces the task's `repo_root` in the
`INVALID_CLAIM_PATH` rejection message so agents see the exact anchor their
path failed to resolve against. The `outside_repo` and `unknown` branches of
`claimPathRejectionMessage(reason, file_path, { repo_root })` switch from a
terse "claim path is not claimable: …" to an actionable
"… resolves outside this task's repo_root \"<root>\" …" / "… could not be
resolved relative to this task's repo_root \"<root>\". Either retarget a task
whose repo_root matches the path being claimed, or pass a path that resolves
inside that anchor." So the agent can immediately tell whether to rewrite the
path or claim a different task.

The MCP handler in `apps/mcp-server/src/tools/task.ts` and both
`TaskThread.claimFile` / `TaskThread.normalizeOptionalClaimPath` paths in
`packages/core/src/task-thread.ts` thread the task's repo_root through.
Backward compatible — the `context` arg is optional and existing callers see
the original messages.
