---
"@colony/storage": patch
---

`claimBeforeEditStats` now surfaces the *triggering* claim in
`nearest_claim_examples` instead of the closest-by-rank match. Previously a
`path_mismatch` bucket could report a same-file claim that was 4+ days old
(outside the 5-minute window) with `same_file_path: true`,
`claim_before_edit: true`, contradicting the bucket label. The example now
carries the in-window same-lane claim that actually triggered the
`path_mismatch` (different file, recent timestamp). The same correction
applies to `claim_after_edit` and the prior-same-file `*_mismatch` buckets;
`pre_tool_use_missing` and `no_claim_for_file` keep the existing
nearest-by-rank fallback.
