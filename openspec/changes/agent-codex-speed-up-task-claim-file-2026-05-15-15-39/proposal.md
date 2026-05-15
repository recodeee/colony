## Why

`task_claim_file` runs on the edit hot path. `colony gain` showed an average
runtime above 3 seconds, and the MCP handler always performed the full live
file contention scan even for ordinary uncontended claims where that payload is
empty.

## What Changes

- Remove the unconditional live-contention scan from successful
  `task_claim_file` responses.
- Keep the guarded claim decision as the authority for blocking active owners,
  stale claims, protected branches, and same-session refreshes.
- Return the existing response shape with `warning: null` and
  `live_file_contentions: []` for successful claims.

## Impact

- Cuts one repo-wide task/claim scan and OMX active-session read from the common
  claim path.
- Preserves existing hard-block behavior for active owners through
  `guardedClaimFile`.
- Adds a focused hot-path budget test for uncontended claim batches.
