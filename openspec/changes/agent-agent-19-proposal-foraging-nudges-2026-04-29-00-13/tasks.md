# Tasks: proposal foraging nudges

## Implementation

- [x] Inspect `task_propose`, `task_reinforce`, and `task_foraging_report`.
- [x] Add `task_post` recommendation text for future-work notes/decisions.
- [x] Add `colony debrief` guidance when proposal calls are absent.
- [x] Add docs/examples for propose, reinforce, and report flows.

## Verification

- [x] Run focused MCP server tests.
  - `pnpm --filter @colony/mcp-server exec vitest run test/task-threads.test.ts test/server.test.ts` -> 37 passed.
- [x] Run focused CLI debrief tests.
  - `pnpm --filter @imdeadpool/colony-cli exec vitest run test/debrief.test.ts` -> 13 passed.
- [x] Run typecheck or record blocker.
  - `pnpm --filter @colony/mcp-server typecheck` -> passed.
  - `pnpm --filter @imdeadpool/colony-cli typecheck` -> passed.
- [x] Run static/spec checks.
  - `pnpm exec biome check apps/mcp-server/src/tools/task.ts apps/mcp-server/test/task-threads.test.ts apps/mcp-server/test/server.test.ts apps/cli/src/commands/debrief.ts apps/cli/test/debrief.test.ts` -> passed.
  - `openspec validate --specs` -> 2 passed, 0 failed.

## Completion / Cleanup

- [ ] Commit changes.
  - BLOCKED: `git add ...` cannot create `.git/worktrees/colony__agent-19__proposal-foraging-nudges-2026-04-29-00-13/index.lock` inside the sandbox; escalation was rejected by usage limit.
- [ ] Push branch.
- [ ] Open/update PR and record URL.
- [ ] Verify PR state is `MERGED`.
- [ ] Verify sandbox worktree cleanup.
