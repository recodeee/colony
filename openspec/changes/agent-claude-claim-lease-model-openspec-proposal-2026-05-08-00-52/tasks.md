# Tasks

## 1. Inspect Existing Claim Lifecycle

- [ ] Map every write site that mutates `task_claims` (claim, release, sweep
      transitions to `weak_expired`, handoff_pending).
- [ ] Map every owner-side coordination call that names a
      `(task_id, file_path)` candidate for renewal.
- [ ] Confirm `coordination-sweep` already gates `weak_expired` transitions on
      `expires_at` so renewal piggybacks cleanly.

## 2. Lease Renewal Engine

- [ ] Add a single `renewClaimLease(store, { taskId, sessionId, filePath, now,
      durationMs })` helper in `@colony/core` that updates `expires_at`
      atomically only when the claim is `state='active'` and the session is
      the current owner.
- [ ] Wire renewal calls into the MCP write paths: `task_claim_file` (re-claim
      by current owner), `task_note_working`, and `task_post` observation
      creation when a claimed `file_path` is named.
- [ ] Add a guarded migration step: when renewal runs and finds the claim has
      `expires_at IS NULL`, set `expires_at = now + duration`. Never set
      `expires_at` retroactively to a past value.

## 3. Settings And Defaults

- [ ] Add `claimLeaseDurationMinutes` to `SettingsSchema` (default 30) with a
      `.describe(...)` string so it surfaces in `colony config show` and
      `settingsDocs()`.
- [ ] Document interaction with the existing coordination-sweep window in the
      capability spec context, not in `CLAUDE.md`.

## 4. MCP Response Surface

- [ ] Extend `task_claim_file` response with `lease_expires_at` and
      `lease_last_renewed_at`. Existing fields stay stable.
- [ ] Update the corresponding MCP integration test to assert the new fields
      are present and monotonic across re-claims.

## 5. Verification

- [ ] Unit tests for `renewClaimLease`: idempotency, ownership check, null
      `expires_at` migration, no extension after `weak_expired`.
- [ ] Integration test: long-running session that claims a file, sleeps past
      the original TTL while emitting `task_note_working`, and verifies the
      claim is still `active` after the would-be expiry.
- [ ] Integration test: a session that never renews has its claim collected
      by the existing coordination sweep with no behavior change.
- [ ] Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and
      `openspec validate --specs`.

## 6. Completion

- [ ] Commit, push, open PR.
- [ ] Record final `MERGED` evidence and sandbox cleanup.
