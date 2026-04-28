# Tasks

## 1. Inspect Existing Surfaces

- [x] Inspect `hivemind_context`.
- [x] Inspect `attention_inbox`.
- [x] Inspect `task_ready_for_agent`.
- [x] Inspect `search`.

## 2. Local Neighborhood Mode

- [x] Extend `hivemind_context` with local mode inputs:
      `repo_root`, `session_id`, optional `task_id`, and optional `files`.
- [x] Return compact current task, matching file claims, pheromone trails,
      negative pheromones, memory hits, unread/blocking attention IDs, and ready
      next action.
- [x] Keep observation bodies behind `get_observations`.
- [x] Keep local mode compact and avoid global task-list overload.

## 3. Verification

- [x] Add tests for compactness and relevance.
      Evidence: `apps/mcp-server/test/server.test.ts` covers local mode, file
      relevance, body hydration, and same-repo blockers addressed to the
      current session.
- [x] Run targeted MCP tests.
      Evidence: `pnpm exec vitest run apps/mcp-server/test/server.test.ts`
      passed 16 tests.
- [x] Run typecheck/lint for touched files.
      Evidence: `pnpm --filter @colony/mcp-server typecheck` passed;
      `pnpm exec biome check apps/mcp-server/src/tools/hivemind.ts
      apps/mcp-server/src/tools/shared.ts apps/mcp-server/test/server.test.ts`
      passed.
- [x] Run OpenSpec validation.
      Evidence: `openspec validate
      agent-agent-19-local-neighborhood-context-2026-04-28-22-31 --strict`
      passed.

## 4. Completion

- [x] Commit, push, PR, merge.
      Evidence: implementation commit `8c2700f` was pushed on
      `agent/agent-19/local-neighborhood-context-2026-04-28-22-31`
      and merged through PR #177:
      https://github.com/recodeee/colony/pull/177.
- [x] Record final `MERGED` evidence and sandbox cleanup.
      Evidence: `gh pr view
      agent/agent-19/local-neighborhood-context-2026-04-28-22-31 --json
      number,url,state,mergeCommit,headRefName,baseRefName` returned
      `state=MERGED`, `number=177`, and merge commit
      `c85ceb8857dbf1dc85a3b4c5bef8ec0529024757`. Guardex finish pruned the
      source worktree, removed the local source branch, and
      `git ls-remote --heads origin
      agent/agent-19/local-neighborhood-context-2026-04-28-22-31` returned no
      remote head.

Closeout resumed after the previous index-write blocker. Verification was rerun
successfully before staging and again after rebase conflict resolution.
