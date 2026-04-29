# Checkpoints

## Rollup

- available: 0
- claimed: 0
- completed: 5
- blocked: 0

## Subtasks

- [x] sub-0 Claim/edit correlation diagnostics [completed] (codex) - Claim miss buckets now explain no claim, after-edit, session/path/repo/branch mismatches, pseudo paths, and missing PreToolUse signals. Evidence: `pnpm --filter @colony/storage test -- claim-path coordination-activity` passed 22 tests; `pnpm --filter @imdeadpool/colony-cli test -- health` passed 18 tests.
- [x] sub-1 Path normalization [completed] (codex) - Path normalization helper and focused test verified. Evidence: pnpm --filter @colony/storage exec vitest run test/claim-path.test.ts passed (6 tests).
- [x] sub-2 Session/branch fallback matching [completed] (codex) - Session/branch fallback matching verified through auto-claim coverage. Evidence: pnpm --filter @colony/hooks exec vitest run test/auto-claim.test.ts passed (36 tests).
- [x] sub-3 Codex/OMX bridge signals [completed] (codex) - `task_claim_file`, PreToolUse, PostToolUse, and auto-claim paths now share claim normalization and skip pseudo paths. Evidence: `pnpm --filter @colony/hooks test -- runner` passed 21 tests; `pnpm --filter @colony/mcp-server test -- task-threads` passed 28 tests.
- [x] sub-4 Health verification [completed] (codex) - Health payload and text output include claim miss diagnostics, Queen readiness, and task-ready conversion checks. Evidence: `pnpm --filter @imdeadpool/colony-cli test -- health` passed 18 tests.

## Completion Gate

- [x] All subtasks complete.
- [x] Spec change archived or explicitly marked not applicable. Not archived before PR; change artifacts remain as implementation evidence. Evidence: `openspec validate --specs` passed 2 specs.
- [x] Verification evidence recorded.
