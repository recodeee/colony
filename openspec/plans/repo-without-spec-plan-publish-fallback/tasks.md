# Tasks

| # | Status | Title | Files | Depends on | Capability | Spec row | Owner |
| - | - | - | - | - | - | - | - |
0|completed|Patch and test no-SPEC plan publication|`apps/mcp-server/src/tools/plan.ts`<br>`apps/mcp-server/src/tools/queen.ts`<br>`apps/mcp-server/test/plan.test.ts`<br>`apps/mcp-server/test/queen.test.ts`<br>`apps/mcp-server/test/ready-queue.test.ts`<br>`packages/spec/src`<br>`apps/mcp-server/src/tools/ready-queue.ts`<br>`apps/mcp-server/src/tools/shared.ts`|-|api_work|-|codex@019e0197|
1|completed|Record task #3 recovery evidence|`openspec/changes`<br>`SPEC.md`|0|doc_work|-|codex@019e0197|

## Completion Evidence

- Task #6 note `55522`: local repair proof and merge/reload next step.
- Task #3 note `55526`: recovery evidence plus exact retry after merged Colony MCP reload.
- Verification: `pnpm --filter @colony/mcp-server test -- plan.test.ts queen.test.ts ready-queue.test.ts` passed, 76 tests.
- Verification: `pnpm --filter @colony/spec test` passed, 19 tests.
- Verification: `pnpm --filter @colony/mcp-server typecheck` passed.
- Verification: `pnpm --filter @colony/spec typecheck` passed.
- Verification: `pnpm exec biome check apps/mcp-server/src/tools/ready-queue.ts apps/mcp-server/src/tools/shared.ts apps/mcp-server/src/tools/heartbeat.ts apps/mcp-server/test/plan.test.ts apps/mcp-server/test/queen.test.ts apps/mcp-server/test/ready-queue.test.ts packages/spec/src/index.ts packages/spec/src/plan-publish.ts packages/spec/src/repository.ts` passed.
- Verification: `openspec validate --specs` passed, 2 specs.
