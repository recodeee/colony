---
"@colony/core": minor
"@imdeadpool/colony-cli": minor
---

Add `colony lane contentions` to surface every file currently held by
two or more concurrent strong claims, regardless of which session is
asking. The verb prints each contended file with all its claimers
(session id, agent, branch, last-seen heartbeat) and emits a suggested
`colony lane takeover` command per losing claim — defaults to keeping
the most recent claim and demoting the older ones. Auto-resolution is
intentionally not done because breaking an active session's claim
mid-edit is risky; the operator confirms by running the suggested
takeover.

Backed by a new `listLiveFileContentions(store, options)` helper in
`@colony/core` that complements the existing per-session
`liveFileContentionsForSessionClaims` / `liveFileContentionsForClaim`
walkers.
