## 1. Implementation

- [x] Inspect quota-pending claim storage and ready-queue filtering.
- [x] Include released `weak_expired` quota claims in `quota_relay_ready`.
- [x] Keep `task_claim_quota_accept` claim args valid for weak-expired relays.
- [x] Preserve live pending accept behavior for still-pending handoff rows.

## 2. Verification

- [x] Add ready-queue regression for released weak-expired quota relays.
- [x] Run `pnpm --filter @colony/mcp-server test -- ready-queue`.
- [x] Run `pnpm --filter @colony/mcp-server test -- task-threads.test.ts`.
- [x] Run `pnpm --filter @colony/mcp-server typecheck`.
- [x] Run `pnpm exec biome check apps/mcp-server/src/tools/ready-queue.ts apps/mcp-server/test/ready-queue.test.ts`.
- [x] Run `pnpm --filter @colony/mcp-server build`.
- [x] Run OpenSpec validation: `openspec validate agent-agent-7-quota-relay-ready-work-2026-05-01-16-28 --strict`.

## 3. Completion / Cleanup

- [x] Commit changes: `25f0c8d`.
- [x] Push branch.
- [x] Open/update PR: https://github.com/recodeee/colony/pull/337
- [x] Record PR URL: https://github.com/recodeee/colony/pull/337
- [x] Verify PR state is `MERGED`: `gh pr view agent/agent-7/quota-relay-ready-work-2026-05-01-16-28 --json number,url,state,mergeCommit,headRefName,baseRefName` returned `state=MERGED`, `mergeCommit=d4e3e7b882ea7f2672a81f339521f4eb9ae36f57`.
- [x] Verify sandbox worktree cleanup: `git worktree list` no longer lists `colony__agent-7__quota-relay-ready-work-2026-05-01-16-28`, and the local source branch is removed.
