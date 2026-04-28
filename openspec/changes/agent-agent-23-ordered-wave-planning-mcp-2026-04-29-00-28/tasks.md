# Tasks

## 1. MCP Publish Input

- [x] Add ordered wave hints to `task_plan_publish`.
- [x] Support wave references by subtask index, title, and capability ref.
- [x] Preserve existing flat publish behavior when wave hints are omitted.

## 2. MCP Publish Output

- [x] Return `plan_slug`, `waves`, subtask indexes, and structured claim instructions.
- [x] Add the same publish guidance to Queen plan publication output.

## 3. Tests

- [x] Cover explicit MCP wave hints.
- [x] Cover wave-based subtask reordering.
- [x] Cover Queen publish response guidance.

## 4. Verification

- [x] `pnpm --filter @colony/mcp-server test -- test/plan.test.ts test/queen.test.ts`
- [x] `pnpm --filter @colony/mcp-server test -- test/server.test.ts`
- [x] `pnpm --filter @colony/mcp-server typecheck`
- [x] `pnpm exec biome check apps/mcp-server/src/tools/plan.ts apps/mcp-server/src/tools/queen.ts apps/mcp-server/src/tools/plan-output.ts apps/mcp-server/test/plan.test.ts apps/mcp-server/test/queen.test.ts`
- [x] `openspec validate --specs`
- [x] `openspec validate agent-agent-23-ordered-wave-planning-mcp-2026-04-29-00-28 --strict`

## 5. Completion

- [ ] Commit, push, PR, merge.
- [ ] Record PR URL, final `MERGED` evidence, and sandbox cleanup state.
