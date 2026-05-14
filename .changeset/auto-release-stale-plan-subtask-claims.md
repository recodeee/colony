---
'@colony/core': minor
'@colony/mcp-server': minor
---

Auto-release stale plan-subtask claims in `task_ready_for_agent`

A `claimed` subtask older than `STALE_PLAN_SUBTASK_CLAIM_MS` (default 1h)
is now released server-side at the top of `task_ready_for_agent` so the
ready-queue can route it to the next eligible worker on the same tick.
Replaces the prior `rescue_candidate` + `next_tool: rescue_stranded_scan`
suggestion path, which deadlocked policy-locked worker fleets (codex,
others) that refuse to rescue another agent's claim.

New behavior:
- The response carries `auto_released_stale_claims[]` listing the
  releases performed by this call (omitted when nothing was stale).
- Pass `auto_release_stale_claims: false` to suppress the sweep and
  observe stale state without mutating it (admin / telemetry callers).
- A new `autoReleaseStalePlanSubtaskClaims(store, plans, options)`
  export from `@colony/core` exposes the same sweep to other consumers
  (e.g. an autopilot tick).

Audit trail: each release writes one `plan-subtask-claim` observation
with `status: 'available'` and `rescue_reason: 'auto-released-stale-claim'`,
matching the shape `bulkRescueStrandedSessions` already uses.
