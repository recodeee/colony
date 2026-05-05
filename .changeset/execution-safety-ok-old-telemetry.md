---
"@imdeadpool/colony-cli": patch
---

`colony health` execution_safety now de-escalates from `bad` to `ok`
when the only red flag is `old_telemetry_pollution` and the recent
window is at-or-above the claim-before-edit target. The headline still
shows the root cause (so the operator knows why the 24h ratio looks
weak), but the readiness scorer no longer nags to "fix" a lifecycle
bridge that is already healthy — it just needs the older edits to age
out of the selected window.

Any actually-current red flag (live contentions, dirty contended files,
codex-rollout-without-bridge, session binding missing, or any non-stale
root cause) keeps execution_safety at `bad`.
