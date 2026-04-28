# Tasks

## 1. Implementation

- [x] Inspect CLI command registration structure.
- [x] Add `colony bridge status --json`.
- [x] Wire `--repo-root`, `--session-id`, `--agent`, and `--branch`.
- [x] Reuse the MCP bridge-status payload builder for matching output.

## 2. Verification

- [x] Add CLI test coverage.
- [x] Run `pnpm --filter @imdeadpool/colony-cli test -- bridge.test.ts program.test.ts`.
- [x] Run `pnpm --filter @colony/mcp-server test -- bridge-status.test.ts`.
- [x] Run `pnpm --filter @imdeadpool/colony-cli typecheck`.
- [x] Run `pnpm --filter @colony/mcp-server typecheck`.
- [x] Run `pnpm --filter @imdeadpool/colony-cli build`.
- [x] Manually run built `colony bridge status --json` against a temp data dir.

## 3. Cleanup

- [x] Commit, push, PR, merge, and sandbox cleanup.
- PR URL: https://github.com/recodeee/colony/pull/211.
- Merge state: `MERGED` at `2026-04-28T22:25:46Z`; `gh pr view agent/agent-12/colony-bridge-status-cli-json-locked-2026-04-29-00-03 --repo recodeee/colony --json number,url,state,mergeCommit,headRefName,baseRefName,mergedAt` returned merge commit `4cda716568d8b75f27d1984f9686f3cc1c419787`.
- Sandbox cleanup: source worktree `colony__agent-12__colony-bridge-status-cli-json-locked-2026-04-29-00-03` is absent from `git worktree list` after guarded finish cleanup.
