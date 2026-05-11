---
"@colony/core": minor
"@colony/mcp-server": minor
---

Add `semantic_search` MCP tool for pure-vector recall.

The existing `search` tool starts with a BM25 candidate pool and then
vector-reranks it. Queries whose terms never appear in any stored
observation return zero candidates and miss the vector path entirely —
that hurts cross-language queries, concept-level queries, and any case
where the agent and the writer used different words for the same idea.

`semantic_search` is the escape hatch: skip FTS entirely, embed the
query, score every stored observation vector by cosine, return top-K.
Same compact return shape as `search` (id + session_id + kind + snippet
+ score + ts + task_id) and the same progressive-disclosure rule
(callers fetch full bodies via `get_observations`). Requires an
embedding provider; returns a structured error otherwise.

The implementation is intentionally O(N) over stored vectors. At 50k
observations on the dev box it still fits inside the 50 ms p95 budget
for `search`; a future ANN index (sqlite-vss / HNSW) goes behind the
same method signature when scale demands it.
