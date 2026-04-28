# Tasks

## 1. Inspect Existing APIs

- [x] Inspect `task_post` MCP registration.
- [x] Inspect `TaskThread.post` and task lookup APIs.
- [x] Inspect task-thread tests and ToolSearch description tests.

## 2. Implementation

- [x] Add Colony-native working note tool.
- [x] Resolve active task from session plus optional repo/branch.
- [x] Return compact candidates on ambiguity.
- [x] Keep notes task/session scoped through `MemoryStore`.

## 3. Tests And Docs

- [x] Add tests for single active task resolution.
- [x] Add tests for repo/branch disambiguation.
- [x] Add tests for ambiguous candidate response.
- [x] Add ToolSearch-friendly description test.
- [x] Update README and MCP docs.

## 4. Verification

- [x] `pnpm exec vitest run apps/mcp-server/test/task-threads.test.ts apps/mcp-server/test/server.test.ts`
- [x] `pnpm --filter @colony/mcp-server typecheck`
- [x] `pnpm exec biome check apps/mcp-server/src/tools/task.ts apps/mcp-server/test/task-threads.test.ts apps/mcp-server/test/server.test.ts README.md docs/mcp.md`
- [x] `openspec validate agent-agent18-working-note-auto-resolution-2026-04-28-22-26 --strict`
- [x] `git diff --check`

## 5. Completion

- [x] Commit changes: `495f7f0` before PR merge.
- [x] Push branch: `agent/agent18/working-note-auto-resolution-2026-04-28-22-26`.
- [x] Open/update PR: https://github.com/recodeee/colony/pull/169.
- [x] Merge PR and record final `MERGED` evidence: `gh pr view agent/agent18/working-note-auto-resolution-2026-04-28-22-26 --repo recodeee/colony --json number,url,state,headRefName,baseRefName,mergeCommit` returned `state=MERGED`, `mergeCommit=1d7b270d21b7c99ad4a8e718bbe0d7b7f0d709b7`.
- [x] Confirm sandbox worktree cleanup: `git worktree list` no longer includes `colony__agent18__working-note-auto-resolution-2026-04-28-22-26`, and `git branch --list "agent/agent18/working-note-auto-resolution-2026-04-28-22-26"` returned no local branch.
