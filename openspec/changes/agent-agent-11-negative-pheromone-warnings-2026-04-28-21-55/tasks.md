# Tasks

## 1. Inspect Current Coordination Kinds

- [x] Inspect observation kinds and `task_post` kinds.
- [x] Confirm storage accepts generic observation kinds without schema changes.

## 2. Add Negative Signals

- [x] Add explicit negative coordination kinds.
- [x] Allow `task_post` to store negative warning kinds.
- [x] Include compact negative warnings in relevant context and ready-work
      surfaces.

## 3. Tests And Docs

- [x] Test negative note storage.
- [x] Test search returns the negative warning.
- [x] Test `hivemind_context` and `task_ready_for_agent` include compact
      warnings.
- [x] Document use cases and advisory semantics.

## 4. Completion

- [x] Run focused tests and validation.
      Evidence: `pnpm --filter @colony/core test -- test/memory-store-search.test.ts`;
      `pnpm --filter @colony/mcp-server test -- test/task-threads.test.ts test/coordination-loop.test.ts test/server.test.ts`;
      `pnpm --filter @colony/storage typecheck`; `pnpm --filter @colony/core typecheck`;
      `pnpm --filter @colony/mcp-server typecheck`; `pnpm lint`;
      `openspec validate --specs`.
- [x] Commit, push, PR, merge.
      Evidence: PR `#164` (`https://github.com/recodeee/colony/pull/164`) is
      `MERGED` with merge commit `113591b55a7321580c10fa9cac42dfa89c91f2e5`.
- [x] Record final `MERGED` evidence and sandbox cleanup.
      Evidence: `gh pr view agent/agent-11/negative-pheromone-warnings-2026-04-28-21-55 --json number,url,state,mergeCommit,headRefName,baseRefName`
      returned `state: "MERGED"`; `git worktree list | rg 'negative-pheromone|agent-11'`
      returned no source worktree for the merged branch, and local branch
      `agent/agent-11/negative-pheromone-warnings-2026-04-28-21-55` was absent.
