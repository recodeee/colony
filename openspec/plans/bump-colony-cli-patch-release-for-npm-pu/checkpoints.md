# Checkpoints

## Rollup

- available: 0
- claimed: 0
- completed: 2
- blocked: 0

## Subtasks

- [x] sub-0 Update release metadata [completed]
- [x] sub-1 Verify publish readiness [completed]

## Completion Gate

- [x] All subtasks complete.
- [x] Spec change archive not applicable before PR merge; Colony auto-archive skipped because it did not see the worktree-local change directory.
- [x] Verification evidence recorded.

## Evidence

- npm registry latest before bump: `@imdeadpool/colony-cli` `0.6.0`.
- Changesets release version: `@imdeadpool/colony-cli` `0.7.0`.
- Verification: `pnpm run check:no-bridge-deps`, `pnpm --filter @imdeadpool/colony-cli typecheck`, `pnpm exec biome check .`, `openspec validate --specs`, and `pnpm publish:cli:dry-run` passed.
- Colony completion: sub-0 and sub-1 marked completed; auto-archive skipped with reason `change directory missing and no archive found`.
