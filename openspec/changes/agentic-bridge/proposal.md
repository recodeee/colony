# Agentic Bridge

## Motivation

Colony needs one durable OpenSpec anchor for the agentic-bridge waves so the
reflexion, retry, ONNX, and lineage slices land under a shared contract instead
of separate ad hoc implementation notes.

Agent 66's pattern catalog in `docs/agentic-bridge.md` is the reference source
for pattern shape. This change intentionally cites that catalog and defines
scope boundaries without copying its prose into the spec scaffold.

## Scope

- Reflexion contracts for capturing agent self-critique, decision review, and
  follow-up materialization points.
- Retry contracts for bounded attempts, failure classification, backoff, and
  durable retry evidence.
- ONNX contracts for local model execution boundaries, packaging constraints,
  and optional runtime integration points.
- Lineage contracts for tracing agentic outputs back to source prompts,
  artifacts, model/runtime choices, and retry/reflexion decisions.

## Out Of Scope

- Skill composition.
- Anti-hallucination systems beyond explicit reflexion and retry evidence.
- Brain, edge, GNN, or SONA architecture work.
- Runtime behavior implementation for any wave.
- Changes to existing Colony coordination semantics.

## Contract Direction

The learning context introduced here is a placeholder for the wave contracts.
Later waves must materialize concrete requirements and scenarios without
expanding this change into behavior implementation.
