# Tasks

- [x] Search coordination sweep, rescue, stale claim, and claim transition logic.
- [x] Identify why stale claims remain after sweep.
- [x] Add safe stale claim release/downgrade handling.
- [x] Preserve history through audit observations.
- [x] Add JSON fields for released, downgraded, dirty-skipped, downstream blockers, and recommended actions.
- [x] Add tests for safe release, dirty skip, and downstream blocker rescue.
- [ ] Run storage, CLI, live sweep, health, and OpenSpec verification.
  - Storage: `pnpm --filter @colony/storage test` passed.
  - Core sweep: `pnpm --filter @colony/core test -- coordination-sweep` passed.
  - CLI coordination: `pnpm --filter @imdeadpool/colony-cli test -- coordination` passed.
  - Typecheck: `pnpm typecheck` passed.
  - OpenSpec: `openspec validate agent-codex-coordination-sweep-safe-stale-cleanup-2026-04-29-22-03 --strict` passed.
  - Health: `colony health --hours 1` passed; reported 19 stale claims and 0 stale downstream blockers.
  - BLOCKED: `colony coordination sweep --json` failed in sandbox with `attempt to write a readonly database`; escalated rerun is unavailable until approval/quota clears.

## Cleanup

- [ ] Finish PR, merge, and sandbox cleanup; record PR URL and `MERGED` evidence.
