# Tasks

- [x] Inspect `.omx/agent-worktrees` and `.omc/agent-worktrees`.
- [x] Collect branch, dirty files, claimed files, and active session per managed worktree.
- [x] Detect same dirty file across multiple managed worktrees.
- [x] Add `colony worktree contention --json`.
- [x] Add `colony health` live contention metrics and top-conflict rendering.
- [x] Add temp git worktree coverage for duplicate dirty files.
- [x] Add health JSON/text coverage for same-file multi-owner conflicts.
- [x] Run targeted tests and typecheck.

## Cleanup

- [x] Finish PR, merge, and sandbox cleanup; record PR URL and `MERGED` evidence.

  - PR: https://github.com/recodeee/colony/pull/284
  - MERGED: `gh pr view agent/codex/live-file-contention-2026-04-29-13-29 --repo recodeee/colony --json number,url,state,mergedAt,mergeCommit,headRefName,baseRefName,title` returned `state=MERGED`, `mergedAt=2026-04-29T13:12:11Z`, `mergeCommit=fcb047031c41b03b2744a55eacd0908834741ab7`.
  - Sandbox cleanup: `gx branch finish --branch agent/codex/live-file-contention-2026-04-29-13-29 --base main --via-pr --wait-for-merge --cleanup` removed the source worktree and local/remote source branches; `git worktree list --porcelain` no longer lists `colony__codex__live-file-contention-2026-04-29-13-29`.
