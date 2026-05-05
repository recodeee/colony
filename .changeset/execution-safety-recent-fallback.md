---
"@imdeadpool/colony-cli": patch
---

`colony health` execution_safety no longer demands another lifecycle-bridge
fix when the recent window is already clean. Two changes:

- The `lifecycle_claim_mismatch` root cause now defers to
  `old_telemetry_pollution` when the recent 1h window has zero
  `pre_tool_use_missing` and at least the lifecycle-bridge measurable
  threshold of hook-capable edits. Stale 24h `path_mismatch` /
  `worktree_path_mismatch` buckets stop demanding `colony bridge
  lifecycle` reinstall when the active editor session is fine; they
  just need to age out of the window.
- The execution_safety evidence headline falls back to the recent rate
  when the all-time `claim_before_edit_ratio` is `null` (some edits
  lacked `file_path` metadata so status is `not_available`). The
  headline now reads `claim-before-edit n/a (recent 1h: 93%; target
  50%+); ...` instead of a bare `n/a`, so operators see real signal
  during partial-metadata windows.
