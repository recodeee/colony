## Why

Colony already has safe stale-claim cleanup paths, but `colony health` did not
make the evaporation path explicit. Operators saw stale claims and downstream
blockers, then had to infer which sweep command was safe for normal stale
claims and which command was reserved for stale downstream blockers.

## What Changes

- Add a structured `stale_claim_evaporation` health report to JSON output.
- Show the stale-claim evaporation summary in verbose human health output.
- Point health action hints at the exact coordination sweep release commands:
  `--release-safe-stale-claims` for safe inactive/non-dirty claims and
  `--release-stale-blockers` for downstream blockers after owner/rescue review.
- Cover the behavior in focused health regressions.

## Impact

- Affects only CLI health reporting and health action hints.
- Does not change claim cleanup semantics or mutate claims from `health`.
- Existing automation consuming `action_hints[].command` gets a more direct
  stale-claim cleanup command.
