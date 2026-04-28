## Implementation

- [x] Inspect `hivemind_context`, `attention_inbox`, `task_claim_file`, health classifiers, and related resume ownership paths.
- [x] Keep expired claims out of the health stale bucket and active ownership count.
- [x] Restrict relay inherited claims to fresh active ownership.
- [x] Add regression tests with stale and expired claim timestamps.
- [x] Update MCP docs for weak stale ownership behavior.

## Verification

- [x] `pnpm install --offline --frozen-lockfile --config.confirmModulesPurge=false`
- [x] `pnpm --filter @colony/core test -- task-thread.test.ts`
- [x] `pnpm --filter @imdeadpool/colony-cli test -- health.test.ts`
- [x] `pnpm --filter @colony/core test -- claim-graph.test.ts attention-inbox.test.ts task-thread.test.ts`
- [x] `pnpm --filter @colony/mcp-server test -- task-threads.test.ts server.test.ts plan-validate.test.ts ready-queue.test.ts`
- [x] `pnpm --filter @colony/core typecheck`
- [x] `pnpm --filter @imdeadpool/colony-cli typecheck`
- [x] `pnpm exec biome check apps/cli/src/commands/health.ts apps/cli/test/health.test.ts packages/core/src/task-thread.ts packages/core/test/task-thread.test.ts docs/mcp.md`
- [x] `git diff --check`
- [x] `openspec validate agent-agent-12-stale-expired-claims-active-ownership-2026-04-29-00-47 --strict`

## Completion / Cleanup

- [ ] Commit changes.
- [ ] Push branch.
- [ ] Open/update PR.
- [ ] Merge PR.
- [ ] Prune sandbox worktree.
- [ ] Record final proof.
