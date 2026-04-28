# @colony/foraging

## 0.6.0

### Minor Changes

- 90bc096: Add the foraging indexer and a storage-aware `scanExamples` wrapper.

  `indexFoodSource(food, store, opts)` converts a discovered `FoodSource`
  into 1–N `foraged-pattern` observations (manifest, README,
  entrypoints, filetree), scrubs env-assignment secrets through
  `redact`, and persists via `MemoryStore` so compression and the
  `<private>` tag stripper both run on the write path.

  `scanExamples({ repo_root, store, session_id, limits?, extra_secret_env_names? })`
  walks `<repo_root>/examples/*`, compares each discovered source's
  `content_hash` against `storage.getExample(...)`, and only re-indexes
  when the hash has shifted. Before re-indexing it calls the new
  `Storage.deleteForagedObservations(repo_root, example_name)` so the
  observation set never duplicates across scans.

  Two helpers on `Storage` to let the indexer (and the forthcoming MCP
  tool) work without opening the DB themselves:

  - `deleteForagedObservations(repo_root, example_name): number`
  - `listForagedObservations(repo_root, example_name): ObservationRow[]`

  New `settings.foraging` block (defaults: enabled, `maxDepth: 2`,
  `maxFileBytes: 200_000`, `maxFilesPerSource: 50`,
  `scanOnSessionStart: true`, `extraSecretEnvNames: []`). `colony config
show` and `settingsDocs()` pick it up automatically.

  No MCP tools, CLI commands, or hook wiring yet — those arrive in the
  next PR.

- af5d371: Expose foraged food sources to MCP clients through three new tools and
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

- beaf0f4: Introduce `@colony/foraging` package skeleton. Ships pure-fs primitives
  for foraging — scanning `<repo_root>/examples/<name>/` food sources,
  classifying each by manifest kind (`npm` / `pypi` / `cargo` / `go` /
  `unknown`), computing a change-signal `content_hash` over manifest +
  file tree, and best-effort redaction of common cloud-service secrets
  before anything hits storage.

  No storage writes, no MCP wiring, no hooks yet — those arrive in the
  follow-up PR. This layer stands alone so it can be unit-tested without
  dragging `MemoryStore` into the test fixture.

  Public API: `scanExamplesFs`, `extract`, `readCapped`, `redact`, plus
  the `FoodSource` / `ForagedPattern` / `IntegrationPlan` / `ScanLimits`
  types and `DEFAULT_SCAN_LIMITS` constants.

### Patch Changes

- Updated dependencies [e9e5587]
- Updated dependencies [5c9fa69]
- Updated dependencies [77b4e06]
- Updated dependencies [90bc096]
- Updated dependencies [af5d371]
- Updated dependencies [ed5a0b0]
- Updated dependencies [c027e5d]
- Updated dependencies [cfb6338]
- Updated dependencies [7e5a430]
- Updated dependencies [e6c03f2]
- Updated dependencies [9e559a4]
- Updated dependencies [b158138]
- Updated dependencies [beaf0f4]
- Updated dependencies [2f371d4]
- Updated dependencies [2aec9a9]
- Updated dependencies [49f7736]
- Updated dependencies [1fbc24e]
- Updated dependencies [754949f]
  - @colony/core@0.6.0
  - @colony/storage@0.6.0
  - @colony/config@0.6.0
