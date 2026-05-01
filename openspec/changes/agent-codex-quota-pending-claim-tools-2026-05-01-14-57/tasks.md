# Tasks

- [x] Add MCP schemas and handlers for quota claim accept, decline, and expired release.
- [x] Add core lifecycle operations for accepting quota-pending claims.
- [x] Keep declined quota relays/handoffs visible to other agents and record reason metadata.
- [x] Add `weak_expired` claim state and migration support.
- [x] Add tests for accepted, declined, expired release, already accepted, missing task, no permission, and conflict paths.
- [x] Run focused verification.
  - MCP tests: `pnpm --filter @colony/mcp-server test -- task-threads` passed.
  - Storage tests: `pnpm --filter @colony/storage test` passed.
  - Typecheck: `pnpm --filter @colony/storage typecheck`, `pnpm --filter @colony/core typecheck`, and `pnpm --filter @colony/mcp-server typecheck` passed.
  - Lint/format: `pnpm exec biome check apps/mcp-server/src/tools/task.ts packages/core/src/task-thread.ts packages/core/src/claim-age.ts packages/storage/src/types.ts packages/storage/src/schema.ts packages/storage/src/storage.ts apps/mcp-server/test/task-threads.test.ts` passed.
  - OpenSpec: `openspec validate agent-codex-quota-pending-claim-tools-2026-05-01-14-57 --strict` passed.

## Cleanup

- [ ] Finish PR, merge, and sandbox cleanup; record PR URL and `MERGED` evidence.
