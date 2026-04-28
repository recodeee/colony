# @colony/spec

## 0.6.0

### Minor Changes

- d6bfe31: Add `@colony/spec` — the spec-driven dev lane (colonykit-in-colony).
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
