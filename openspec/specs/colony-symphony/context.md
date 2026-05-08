# Colony Symphony Context

## Overview

Symphony is the upstream service specification being ported into Colony. The
canonical source is `examples/symphony/SPEC.md` in the recodee monorepo, with
`examples/symphony/README.md` as supporting orientation.

The Elixir reference implementation is read-only for this effort. It can inform
terminology and intent, but Colony adoption work must not vendor, translate, or
depend on the Elixir code.

## Rationale

Colony needs a durable reference point before agents split Symphony adoption
into proposals, requirements, and implementation slices. This context records
the source mapping without making any normative Colony requirements yet.

Symphony's tracker model names Linear because the reference spec targets a
Linear-backed service. For Colony adoption, Linear-as-tracker is N/A: Colony is
the tracker and coordination substrate.

## Scope

This capability context covers the documentation bridge between the Symphony
SPEC and future Colony OpenSpec changes. It is limited to source identity,
porting boundaries, and mapping anchors.

Normative requirements, behavior deltas, and change proposals are intentionally
out of scope here. Agent 202 owns the change proposal that will decide which
Symphony patterns become Colony requirements.

## Mapping Anchors

| Adoption phase | Symphony SPEC anchor |
| --- | --- |
| spec import | Sections 1-3: problem statement, goals/non-goals, and system overview |
| front-matter | Sections 5-6: workflow file contract, front matter schema, and configuration resolution |
| run-attempts | Sections 4.1.5, 10, and 16.5: run attempt model, agent runner protocol, and worker attempt algorithm |
| reconcile | Sections 7-8 and 16.3: orchestration state machine, polling/scheduling, and active-run reconciliation |
| proof gating | Sections 12, 17, and 18: prompt/context assembly, validation matrix, and definition of done |
| observability | Section 13: logging, status, snapshots, and operator-visible observability |
| safety | Sections 9 and 15: workspace management, safety invariants, security, and operational safety |
