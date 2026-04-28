# Tasks

## 1. Ready Queue Output

- [x] Inspect current `task_ready_for_agent` output.
- [x] Return exact `task_plan_claim_subtask` routing fields for claimable work.
- [x] Return a compact empty state when no plan subtasks are claimable.

## 2. Tests

- [x] Cover a ready subtask returning claim args.
- [x] Cover blocked future subtasks returning the empty state.
- [x] Cover no subtasks returning the empty state.

## 3. Docs

- [x] Update MCP docs for claim args and empty state.
- [x] Update startup guidance.

## 4. Verification

- [x] `pnpm --filter @colony/mcp-server test -- ready-queue.test.ts tool-descriptions.test.ts`
- [x] `pnpm --filter @colony/mcp-server typecheck`
- [x] `pnpm exec biome check apps/mcp-server/src/tools/ready-queue.ts apps/mcp-server/test/ready-queue.test.ts`
- [x] `openspec validate agent-agent-8-task-ready-claim-args-2026-04-29-00-38 --strict`
- [x] `openspec validate --specs`

## 5. Completion

- [ ] Commit, push, PR, merge.
- [ ] Record PR URL, final `MERGED` evidence, and sandbox cleanup state.
