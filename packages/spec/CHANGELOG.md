# @colony/spec

## 0.8.0

### Patch Changes

- Updated dependencies [4a68470]
- Updated dependencies [e6c5766]
- Updated dependencies [2e8fba1]
- Updated dependencies [3898ff3]
  - @colony/storage@0.8.0
  - @colony/core@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [b937fb7]
- Updated dependencies [77c9e30]
- Updated dependencies [6b09a3d]
- Updated dependencies [c94ed35]
- Updated dependencies [7d86bd2]
- Updated dependencies [cb4c9f9]
- Updated dependencies [46d0153]
- Updated dependencies [36e95ba]
- Updated dependencies [211c646]
- Updated dependencies [528b5ba]
- Updated dependencies [2d84352]
- Updated dependencies [127fdf3]
- Updated dependencies [9424987]
- Updated dependencies [a27c52c]
- Updated dependencies [2a077ed]
- Updated dependencies [08e4700]
- Updated dependencies [2ddc284]
- Updated dependencies [7d86bd2]
- Updated dependencies [fa4e1a3]
- Updated dependencies [610d5c8]
- Updated dependencies [919cc9b]
  - @colony/core@0.7.0
  - @colony/storage@0.7.0

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
