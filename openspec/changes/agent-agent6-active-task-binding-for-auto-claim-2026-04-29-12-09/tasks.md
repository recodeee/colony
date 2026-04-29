# Tasks

- [x] Inspect current auto-claim active task/session lookup.
- [x] Implement ordered task resolution for exact session, repo/branch,
  cwd/worktree, and unambiguous agent fallback.
- [x] Return structured `bound`, `ambiguous`, and `not_found` binding results.
- [x] Add compact ambiguous candidates with title, repo, branch, updated time,
  and active files when present.
- [x] Add not-found suggested action for create/bind and manual
  `task_claim_file`.
- [x] Add focused tests for each resolution path.
- [x] Run targeted verification.

## Completion Evidence

- Tests: `pnpm --filter @colony/hooks test -- auto-claim.test.ts auto-claim-metadata.test.ts` passed, 40 tests.
- Follow-up tests: `pnpm --filter @colony/hooks test -- auto-claim` passed, 49 tests, covering exact session, repo/branch fallback, worktree fallback, and fallback conflict telemetry for Codex/OMX session-id churn.
- Storage path proof: `pnpm --filter @colony/storage test -- claim-path` passed, 9 tests.
- Typecheck: `pnpm --filter @colony/hooks typecheck` passed.
- Lint/format: `pnpm exec biome check packages/hooks/src/auto-claim.ts packages/hooks/test/auto-claim.test.ts` passed.
- Tests: `pnpm --filter @colony/hooks test` passed, 123 tests.
- Typecheck: `pnpm --filter @colony/hooks typecheck` passed.
- Lint/format: `pnpm exec biome check packages/hooks/src/auto-claim.ts packages/hooks/src/handlers/pre-tool-use.ts packages/hooks/test/auto-claim.test.ts packages/hooks/test/auto-claim-metadata.test.ts` passed.
