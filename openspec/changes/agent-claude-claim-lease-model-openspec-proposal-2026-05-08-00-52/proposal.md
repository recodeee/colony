# Lease-Based Claim Renewal

## Why

Today `task_claims.expires_at` is a fixed deadline stamped at claim time. An
agent mid-edit on a 20-minute refactor whose claim was opened with a 10-minute
TTL silently loses ownership even though it has been actively editing — the
sweep cannot tell active work from abandonment, so it picks short TTLs to limit
blast radius and accepts expiring live work as the cost.

A lease model fixes this without adding a new heartbeat tool: a claim's
`expires_at` is renewed every time the owning session touches the same
`(task_id, file_path)` through normal coordination calls. Active work renews
itself; a dead session stops renewing and the existing coordination sweep
collects it.

This closes the planned work tracked in project memory under
`project_claim_ttl_fix.md` (TTL with activity-based renewal).

## What Changes

- `task_claims.expires_at` becomes a renewable lease deadline rather than a
  fixed TTL. Each owner-side coordination call that names the
  `(task_id, file_path)` advances `expires_at` to
  `now + claimLeaseDurationMinutes`.
- Renewal sources for a claim owned by `(task_id, session_id, file_path)`:
  - `task_claim_file` with the same `(task_id, file_path)` from the same
    session (re-claim by current owner).
  - `task_note_working` from the same session whose `file_path` set includes
    the claimed path.
  - `task_post` observations from the same session with a `file_path` field
    matching the claimed path.
- `task_claim_file` response gains `lease_expires_at` and
  `lease_last_renewed_at` so agents can see when their lease will lapse.
- New setting `claimLeaseDurationMinutes` (default 30) replaces the implicit
  TTL knob. The setting is documented through the existing `settingsDocs()`
  pipeline.
- Coordination sweep semantics unchanged at the boundary: claims past
  `expires_at` without renewal still transition `active` → `weak_expired`
  through the existing sweep path. Sweep no longer collects claims whose
  owning session has touched them within the lease window.
- Guarded migration for in-flight claims: any `state='active'` claim with
  `expires_at IS NULL` is treated as `now + claimLeaseDurationMinutes` on
  first owner activity. No retroactive expiry.

## Impact

- Storage: no new columns or migrations. The existing
  `task_claims(expires_at INTEGER, state TEXT)` schema is sufficient.
- MCP surface: no new tool. The contract change is additive fields on
  `task_claim_file` response.
- Backwards compat: callers that ignore the new fields keep working. Existing
  claims with `expires_at IS NULL` are not retroactively expired.
- Performance: lease renewal is one indexed UPDATE per qualifying call. The
  lookup uses the existing `(task_id, file_path)` primary key.
- Out of scope: hierarchical claims (directory/glob), negative claims
  (`do_not_touch`), and explicit yield negotiation. Each is a follow-up
  proposal; this change deliberately keeps lease semantics first because the
  others depend on it.
