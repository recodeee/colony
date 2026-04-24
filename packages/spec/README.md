# @colony/spec · colonykit-in-colony

Spec-driven dev as a colony lane. Adds six MCP tools (`spec_read`, `spec_change_open`, `spec_change_add_delta`, `spec_build_context`, `spec_build_record_failure`, `spec_archive`) and a parallel set of Claude Code skills (`/co:change`, `/co:build`, `/co:check`, `/co:archive`). Rides on colony's `TaskThread`, `ProposalSystem`, `MemoryStore`, and `@colony/compress` — no parallel infra.

## what this package is

The colonykit merge plan, condensed to the parts colony doesn't already have:

- **Spec grammar** (`grammar.ts`). Parse/serialize `SPEC.md` with the six fixed sections §G/§C/§I/§V/§T/§B. Round-trip stable. Always-on invariants identified by `.always` id suffix.
- **Change grammar** (`change.ts`). In-flight `CHANGE.md` with §P/§S/§T/§B plus `base_root_hash` front-matter for the three-way merge ancestor.
- **Sync engine** (`sync.ts`). Three-way merge with three strategies from the v2 plan: `three_way` (default, refuse-on-conflict), `refuse_on_conflict` (explicit), `last_writer_wins` (opt-in, warns).
- **Backprop gate** (`backprop.ts`). Failure signature hashing (test-id + error-class + top-3 frames). Promotes a §V draft via `colony.ProposalSystem` only after `promote_after` matching failures (default 2). No flake-driven invariant churn.
- **Cite-scoped context** (`context.ts`). Given a §T id, returns the transitive closure of its cites plus §V.always. The loader the `/co:build` skill uses — every task loads only what it's obliged to respect.

## what this package is NOT

- Not a standalone CLI. Drops into the colony monorepo as a workspace package; surfaces via the existing colony MCP server and hooks.
- Not a replacement for `task_thread`, `task_propose`, `task_reinforce`, `attention_inbox`. Those still do the work — this package just calls them with spec-shaped arguments.
- Not a new storage schema. Spec observations live on task-threads where `branch` starts with `spec/`. Filtering is a branch-prefix check.

## integration (three files to change)

```
apps/mcp-server/package.json     add @colony/spec: workspace:*
apps/mcp-server/src/server.ts    add registerSpecTools(server, store, settings)
pnpm-workspace.yaml              (already includes packages/*)
```

See `patches/0001-add-spec-tools.patch` for the exact diff.

## file layout in-repo

Install adds these files to any colony-shaped repo once `colonykit init` runs:

```
SPEC.md                              durable root spec (§G §C §I §V §T §B)
openspec/
  config.yaml                        caveman level, validator rules, sync strategy
  changes/
    <slug>/
      CHANGE.md                      §P §S §T §B + base_root_hash
      design.md                      optional, only with /co:change --design
    archive/
      2026-04-24-<slug>/             immutable after /co:archive
```

## mapping to colony primitives

| colonykit concept         | colony primitive                                          |
|---------------------------|-----------------------------------------------------------|
| active change             | `TaskThread` with `branch: spec/<slug>`                   |
| §S delta rows             | `Observation` with `kind: spec-delta`                     |
| §B bug entries            | `Observation` with `kind: spec-bug`, signature in meta    |
| §V draft invariant        | `ProposalSystem` proposal + `kind: spec-invariant-draft`  |
| backprop reinforcement    | `ProposalSystem.reinforce({ kind: 'rediscovered' })`      |
| backprop lookahead        | `MemoryStore.search()` over prior §B signatures           |
| cross-change conflicts    | `TaskThread.claimFile('SPEC.md#V.3')` on the root thread  |
| handoff between agents    | `TaskThread.handOff()` on the change's thread             |
| archive move              | filesystem rename + `spec-sync` observation on root       |

Every one of these is already in `@colony/core`. What's new is the spec-grammar dialect and the discipline of using these primitives for spec mutation.

## tests

```bash
cd packages/spec
pnpm test
```

Covers: grammar round-trip, always-on identification, stable hashing, cite-scoped context with transitive closure, all four sync conflict shapes (clean, drift, cited-removal, last-writer-wins override).

## what's intentionally missing (v0.0.1)

- `colonykit init` — not included; the installer can be a thin wrapper around `SpecRepository.writeRoot()` with a default SPEC.md template. Add when the core loop is proven.
- Token-budget CI gate — defer until we have a fixture repo and a baseline to measure against. Writing it before the baseline is measuring theater.
- `design.md` scaffolding — the `/co:change --design` path is specified in the skill but not yet implemented by `spec_change_open`. One-liner to add when someone asks for it.
- Cross-change concurrent-edit detection — plumbed through `TaskThread.claimFile()` on `SPEC.md#<id>` but not yet surfaced in `/co:check`. Add after the single-change flow is proven end-to-end.

These are deferred intentionally. Prove the core loop on one change before adding surface.
