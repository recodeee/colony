---
'@colony/spec': minor
'@colony/mcp-server': minor
'@imdeadpool/colony': minor
---

Add `@colony/spec` — the spec-driven dev lane (colonykit-in-colony).
Provides a `SPEC.md` grammar, `CHANGE.md` grammar, three-way sync
engine, backprop failure-signature gate, and cite-scoped context
resolver. Rides on `@colony/core`'s TaskThread, ProposalSystem, and
MemoryStore — no parallel infrastructure.

Six new MCP tools land in `apps/mcp-server/src/tools/spec.ts`:
`spec_read`, `spec_change_open`, `spec_change_add_delta`,
`spec_build_context`, `spec_build_record_failure`, `spec_archive`.

Four matching Claude Code skills ship under `skills/` at the repo
root: `/co:change`, `/co:build`, `/co:check`, `/co:archive`, plus
supporting internals (`spec`, `sync`, `backprop`).

Tests: `packages/spec/test/spec.test.ts` covers grammar round-trip,
always-on invariant detection, stable hashing, cite-scope transitive
closure, and all four sync conflict shapes. `apps/mcp-server` tool
list updated to include the six new tools.
