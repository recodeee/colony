---
"@colony/core": minor
"@imdeadpool/colony-cli": minor
---

Add `--release-aged-quota-minutes <minutes>` to `colony coordination
sweep` (and the matching `release_aged_quota_pending_minutes` option on
`buildCoordinationSweep`) for evacuating quota-pending claims that have
been sitting open longer than the supplied threshold, regardless of
whether the per-claim TTL has been reached. The existing
`--release-expired-quota` flag only handles claims past `expires_at`,
so handoffs posted while no agent was around to accept them stay in
the signal-evaporation metric until their TTL — often hours.

Released aged claims still go to `weak_expired` and emit a
`coordination-sweep` audit observation; the linked relay observation
is marked expired the same way it is for the expired-TTL path. The
`released_expired_quota_pending_claims` array now contains both the
expired-TTL and aged-threshold cleanups, distinguished by their
`cleanup_action` (`release_expired_quota_pending` vs
`release_aged_quota_pending`).
