# Tasks

## 1. Inspect Existing Behavior

- [x] Inspect `task_message`, `task_messages`, `task_message_mark_read`, `task_message_claim`, `task_message_retract`, and `attention_inbox`.
- [x] Verify existing TTL behavior for unread-only hiding and audit status surfacing.

## 2. Lifecycle Fixes

- [x] Keep expired unread messages out of default attention/unread inbox views.
- [x] Keep blocking messages prominent and uncoalesced.
- [x] Stop read and replied messages from triggering attention.
- [x] Make `mark_read` on an already-expired message return stable `MESSAGE_EXPIRED`.

## 3. Tests And Docs

- [x] Add FYI coalescing / blocking non-coalescing tests.
- [x] Add blocking prominence tests.
- [x] Add expired message behavior tests.
- [x] Add stable expired `mark_read` tests.
- [x] Update README and MCP docs for changed behavior.

## 4. Verification

- [x] `pnpm exec vitest run packages/core/test/attention-inbox.test.ts packages/hooks/test/attention-budget.test.ts apps/mcp-server/test/messages.test.ts`
- [x] `pnpm --filter @colony/core typecheck`
- [x] `pnpm --filter @colony/hooks typecheck`
- [x] `pnpm --filter @colony/mcp-server typecheck`
- [x] `pnpm exec biome check packages/core/src/messages.ts packages/core/src/task-thread.ts packages/core/src/attention-inbox.ts packages/core/src/attention-budget.ts packages/core/test/attention-inbox.test.ts packages/hooks/test/attention-budget.test.ts apps/mcp-server/test/messages.test.ts`
- [x] `git diff --check`
- [x] `openspec validate agent-agent9-message-alarm-pheromones-2026-04-28-21-51 --strict`

## 5. Completion

- [ ] Commit changes.
- [ ] Push branch.
- [ ] Open/update PR.
- [ ] Merge PR and record final `MERGED` evidence.
- [ ] Confirm sandbox worktree cleanup.
