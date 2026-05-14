## Why

A stale `claimed` plan-subtask used to deadlock a wave indefinitely. When
the worker holding the claim went idle (quota, crash, abandoned context),
the `task_ready_for_agent` queue surfaced a `rescue_candidate` and told
callers to run `rescue_stranded_scan` — but the codex worker fleet is
policy-prohibited from rescuing other agents' claims. Result: every other
agent correctly refused the rescue suggestion and idled, polling
`task_ready_for_agent` indefinitely while a single dead claim blocked the
wave for hours (observed in the codex-fleet screenshot with 7 agents idle
12–37 minutes).

The same telemetry showed `task_plan_claim_subtask` errors jumping
**9 → 103 (+94)** week-over-week, 76 of them `PLAN_SUBTASK_NOT_AVAILABLE:
sub-task is blocked`. That's the wave deadlock playing out in the metrics.

## What Changes

- `task_ready_for_agent` now **auto-releases** plan-subtask claims older than
  `STALE_PLAN_SUBTASK_CLAIM_MS` (default 1h) **before** computing the
  available set. The released subtasks appear as claimable in the same
  response.
- A new opt-out arg `auto_release_stale_claims: false` preserves the legacy
  rescue-candidate surface for telemetry queries and admin tooling that
  want to observe stale state without mutating it.
- The release writes one `plan-subtask-claim` observation with
  `status: 'available'` and `rescue_reason: 'auto-released-stale-claim'`,
  matching the audit shape `bulkRescueStrandedSessions` already writes for
  its session-scoped sweeps.
- A new `auto_released_stale_claims[]` field on the response tells callers
  which claims were released on this tick (omitted when nothing was stale).
- New `autoReleaseStalePlanSubtaskClaims(store, plans, options)` export
  from `@colony/core` shares the implementation with anyone else who needs
  to run the same sweep (e.g. a future autopilot tick).

## Impact

- **Worker fleets stop deadlocking on a single dead claim.** The behavior
  the screenshot reported as "manual OVERRIDE current plan pinning" is now
  the queue's default response.
- The legacy rescue-candidate surface stays reachable behind the opt-out
  flag; the existing `staleBlockerRescueCandidate` test asserts that path
  verbatim with `auto_release_stale_claims: false`.
- Auto-release runs on the hot ready-queue path but only for subtasks
  already in the loaded `plans` array; no extra storage round-trip beyond
  the per-released subtask `readSubtaskByBranch + addObservation` pair.
  Common-case calls (no stale claims) do zero extra work.
- Race-tolerant: writing two `status: 'available'` observations for the
  same subtask is a no-op for status (latest-wins) and only adds a
  redundant audit row.
