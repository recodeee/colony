---
"@colony/storage": minor
---

Add an `examples` table and `upsertExample` / `getExample` / `listExamples` /
`deleteExample` methods to support the forthcoming `@colony/foraging`
package. Each row caches the content hash and observation count for a
`<repo_root>/examples/<name>` food source so repeat scans on
`SessionStart` can skip unchanged directories without touching the
observation table. Schema version bumped 6 → 7.
