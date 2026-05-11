---
"@colony/core": minor
"@colony/mcp-server": minor
---

Add `cluster_observations` MCP tool for semantic dedupe.

Greedy single-linkage clustering by cosine threshold over a caller-
supplied set of observation IDs. The intended consumer is handoff /
attention_inbox dedupe: collect pending handoff IDs, pass them through
`cluster_observations(ids, threshold)`, and show the user one canonical
row per cluster instead of three different agents saying the same thing.

The MCP tool wraps a new `MemoryStore.clusterObservations` primitive,
so callers that already use the core package can dedupe without going
through MCP. Threshold defaults to `0.85`; observations missing an
embedding come back in a separate `unembedded` array so the caller
chooses whether to keep them as singletons. Capped at 500 input IDs to
bound the O(N²) cosine cost.
