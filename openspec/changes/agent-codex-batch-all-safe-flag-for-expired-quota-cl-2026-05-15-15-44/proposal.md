## Why

- Operators can release one expired quota-pending claim at a time with
  `colony task quota-release-expired`, but clearing a queue of expired batons
  still requires repeated manual task IDs.
- The coordination sweep already contains the safe batch primitive that only
  downgrades TTL-expired quota-pending claims and preserves audit history.

## What Changes

- Add `--all-safe` to `colony task quota-release-expired`.
- Route `--all-safe` through `buildCoordinationSweep` with
  `release_expired_quota_claims`.
- Emit a compact text or JSON summary showing released expired quota-pending
  claims.

## Impact

- Affected surface: `apps/cli/src/commands/task.ts`.
- Task-specific release behavior is unchanged unless `--all-safe` is passed.
- `--all-safe` rejects task-specific options to avoid ambiguous partial batch
  cleanup.
