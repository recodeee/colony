---
"@colony/core": minor
"@imdeadpool/colony-cli": minor
---

Add `--release-expired-quota` mode to `colony coordination sweep`.
Quota-pending claims past their `expires_at` are now downgraded to
`weak_expired` and their linked relay/handoff observations are marked
`expired`, with a coordination-sweep audit observation written for each
release. Without the flag, expired quota-pending claims are still
counted in `summary.quota_pending_claims` and `safe_cleanup` so health
can recommend the cleanup. The new `release_expired_quota_claims`
option on `buildCoordinationSweep` mirrors the existing
`release_safe_stale_claims` / `release_same_branch_duplicates` shape:
audit history is retained, dry-run remains the default, and the CLI's
`--dry-run` flag continues to suppress all release modes.
