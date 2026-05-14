---
'@colony/storage': minor
'@colony/core': patch
'@colony/mcp-server': patch
---

Explain `task_claim_file` rejections instead of returning a generic "not claimable"

`task_claim_file` (and the `TaskThread.claimFile` /
`normalizeOptionalClaimPath` paths inside `@colony/core`) used to throw
`INVALID_CLAIM_PATH: claim path is not claimable` with no hint at the
reason. Telemetry showed agents bouncing off the same surface for the same
input — e.g. `colony/packages/core/test` (a directory) — because the
message gave them nothing to act on.

The rejection branch now classifies the failure and renders a specific
message per reason:

- `directory` — *"claim path "X" is a directory; claim individual files inside it instead."*
- `pseudo` — *"claim path "X" is a pseudo path (e.g. /dev/null) and cannot be claimed."*
- `outside_repo` — *"claim path "X" resolves outside this task's repo_root and cannot be claimed."*
- `empty` — *"claim path is empty."*
- fallback — the legacy generic message, still keyed on the input path.

New exports from `@colony/storage`:

- `classifyClaimPathRejection(context)` — pure classifier paralleling
  `normalizeRepoFilePath`. Returns the reason or `null`.
- `claimPathRejectionMessage(reason, file_path)` — single source of
  truth for the user-facing message so the MCP `task_claim_file`
  handler and `TaskThread.claimFile` stay in sync.
- New storage method `classifyTaskFilePathRejection(task_id, file_path,
  cwd?)` plumbs the task → repo_root lookup that the existing
  `normalizeTaskFilePath` already does, so callers only pay for the
  classifier on the error branch.

No behavior change: the same inputs that used to be rejected are still
rejected; only the error message and code surface improve. Existing
INVALID_CLAIM_PATH error code is preserved.
