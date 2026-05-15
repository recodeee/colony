## Why

`colony health --fix-plan` dry-run mode showed the current stale-signal state
but did not return the coordination sweep result or a before/after view of what
the safe cleanup would change. Operators had to run a separate sweep command to
see the concrete release/downgrade impact.

## What Changes

- Run a read-only coordination sweep during health fix-plan dry runs.
- Add a `coordination_sweep_diff` payload with before counts, projected after
  counts, projected release/downgrade counts, and skipped-claim buckets.
- Render the same diff in text output while keeping claim mutation disabled
  unless `--apply --release-safe-stale-claims` is passed.

## Impact

- Dry-run health output becomes more actionable without mutating claims.
- Existing apply behavior remains gated by `--release-safe-stale-claims`.
- Focused health stale-cleanup flow coverage verifies the JSON diff.
