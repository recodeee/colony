---
"@colony/mcp-server": minor
"@imdeadpool/colony-cli": patch
---

`attention_inbox` now defaults to a compact payload (`summary` +
`observation_ids`) and accepts a new `format: "compact" | "full"` flag
that opts back into the historical fully hydrated shape. Compact mode
trims the response to the counts and IDs an agent actually needs to
decide what to call next; bodies stay one `get_observations(ids)` call
away.

The `verbose` and `audit` flags keep their existing semantics
(weak-expired audit-claim visibility) and are now orthogonal to
`format` — full payload + audit, compact + audit, etc., are all valid.
Existing `attention_inbox` callers that depended on the inbox arrays
must pass `format: "full"`.
