# Tasks

## 1. Inspect Current Metrics Path

- [x] Confirm MCP wrapper records per-call tokens, bytes, duration, session,
      repo, and structured errors.
- [x] Confirm current aggregation only exposes operation-level totals and
      averages.

## 2. Add Operation Detail Metrics

- [x] Add derived success/error token and peak token/duration fields to storage
      aggregation.
- [x] Render focused operation details in `colony gain --operation`.
- [x] Keep default report shape compact and avoid raw argument logging.

## 3. Verification

- [x] Run focused storage, CLI, and MCP tests for metrics output.
      Evidence: `pnpm --filter @colony/storage test -- mcp-metrics.test.ts`
      passed 5/5; `pnpm --filter @imdeadpool/colony-cli test -- gain.test.ts`
      passed 6/6; `pnpm --filter @colony/mcp-server test -- server.test.ts`
      passed 21/21.
- [x] Run typecheck for touched packages.
      Evidence: after restoring worktree-local package symlinks to the primary
      pnpm dependency links, `pnpm --filter @colony/storage typecheck`,
      `pnpm --filter @imdeadpool/colony-cli typecheck`, and
      `pnpm --filter @colony/mcp-server typecheck` passed.
- [x] Run build/smoke proof for the CLI output.
      Evidence: `pnpm --filter @colony/storage build` and
      `pnpm --filter @imdeadpool/colony-cli build` passed; live smoke
      `pnpm --filter @imdeadpool/colony-cli exec node dist/index.js gain --operation task_claim_quota_release_expired --hours 168`
      printed `Operation detail` with success/error token and peak metrics.
- [x] Run OpenSpec validation for this change.
      Evidence:
      `openspec validate agent-codex-add-operation-level-mcp-metrics-2026-05-06-01-43 --strict`
      passed.

## 4. Completion

- [x] Commit, push, PR, merge.
      Evidence: PR https://github.com/recodeee/colony/pull/461 reported
      `state=MERGED` with merge commit
      `4be69f12d2f5382988081f4f0cb6cf7e869c164b`.
- [x] Record final `MERGED` evidence and sandbox cleanup.
      Evidence: `git worktree list` no longer listed
      `.omx/agent-worktrees/colony__codex__add-operation-level-mcp-metrics-2026-05-06-01-43`;
      `git branch --list agent/codex/add-operation-level-mcp-metrics-2026-05-06-01-43`
      returned no local branch; `main` and `origin/main` pointed at
      `4be69f12d2f5382988081f4f0cb6cf7e869c164b`.
