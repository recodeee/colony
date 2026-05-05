---
"@imdeadpool/colony-cli": patch
---

`colony health` now surfaces an `execution_safety` action hint when any `LiveContentionOwner` in `live_contention_health.top_conflicts` holds a claim on a protected base branch (`main`/`master`/`dev`/`develop`/`production`/`release`, via the new `isProtectedBranch` helper from `@colony/storage`). Surfaces `gx branch start "<task>" "<agent>"` as the suggested fix and tells operators which branches are involved. Closes the loop on the Wave 2a `GuardedClaimResult.protected_branch` warning — the signal now propagates from claim time → contention payload → dashboard hint.
