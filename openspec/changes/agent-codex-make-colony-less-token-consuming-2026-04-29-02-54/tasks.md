# Tasks

## 1. Inspect Token-Heavy Surfaces

- [x] Inspect `hivemind_context` and `attention_inbox` MCP payloads.
- [x] Identify default `attention_inbox.stalled_lanes` expansion as the largest
      avoidable payload in active repos.

## 2. Compact Attention Inbox

- [x] Cap returned stalled lane rows by default.
- [x] Preserve total stalled lane count and add truncation metadata.
- [x] Expose an explicit MCP/CLI limit for callers that need more rows.

## 3. Verification

- [x] Run targeted tests for attention inbox and MCP schema behavior.
      Evidence: `pnpm --filter @colony/core test -- attention-inbox.test.ts`
      passed 15/15; `pnpm --filter @colony/mcp-server test` passed 143/143;
      `pnpm --filter @colony/hooks test -- attention-budget.test.ts` passed
      7/7; `pnpm --filter @colony/hooks test` passed 112/112.
- [x] Run typecheck or the narrowest compile check for touched packages.
      Evidence: `pnpm --filter @colony/core typecheck`,
      `pnpm --filter @colony/hooks typecheck`,
      `pnpm --filter @colony/mcp-server typecheck`, and
      `pnpm --filter @imdeadpool/colony-cli typecheck` passed.
- [x] Run OpenSpec validation.
      Evidence:
      `openspec validate agent-codex-make-colony-less-token-consuming-2026-04-29-02-54 --strict`
      passed.

## 4. Completion

- [x] Commit, push, PR, merge.
      Evidence: PR https://github.com/recodeee/colony/pull/244 merged into
      `main` as `b937fb708deb4b8be49c10e8e7361ea42e494b49`.
- [x] Record final `MERGED` evidence and sandbox cleanup.
      Evidence: `gh pr view 244 --json number,url,state,mergeCommit`
      reported `state=MERGED`; `git worktree list` showed only
      `/home/deadpool/Documents/recodee/colony` on `main` after cleanup.
