---
"@colony/foraging": minor
"@colony/core": minor
"@colony/storage": minor
"@colony/mcp-server": minor
---

Expose foraged food sources to MCP clients through three new tools and
wire `MemoryStore.search` with an optional kind/metadata filter so
scoped queries don't pollute the main search.

New MCP tools (registered alongside spec in `apps/mcp-server`):

- `examples_list({ repo_root })` — compact list of indexed example
  names, manifest kinds, and cached observation counts.
- `examples_query({ query, example_name?, limit? })` — BM25 hits
  scoped to `kind = 'foraged-pattern'` and optionally to a specific
  example. Returns compact snippets — fetch full bodies via
  `get_observations`.
- `examples_integrate_plan({ repo_root, example_name, target_hint? })`
  — deterministic plan: npm dependency delta between the example and
  the target `package.json`, files to copy (derived from indexed
  entrypoints), `config_steps` (npm scripts), and an
  `uncertainty_notes` list for everything the planner couldn't
  resolve. No LLM in the loop.

`@colony/foraging` adds `buildIntegrationPlan(storage, opts)`. The
function reads manifests fresh from disk to avoid round-tripping
structured JSON through the compressor.

`@colony/core` extends `MemoryStore.search(query, limit?, embedder?, filter?)`
with `{ kind?: string; metadata?: Record<string, string> }`. When a
filter is set the method skips vector ranking — the embedding index has
no kind column, so mixing vector hits would require a second pass to
drop them. `@colony/storage`'s `searchFts(query, limit, filter?)`
applies the filter in SQL via `json_extract` so the LIMIT still bounds
the scan.
