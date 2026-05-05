# Agentic Bridge Research Notes

This document records the narrow patterns Colony should port from
`examples/agentic-flow` and `https://github.com/ruvnet/ruvector`. It is a
research anchor for waves 2-5, not an implementation spec and not permission to
vendor either project.

## Pattern catalog

**Reflexion memory.** In Agentic-Flow, `ReflexionMemoryController` records a
failed or successful attempt as structured memory with `taskId`, `attempt`,
`action`, optional `observation`, `reflection`, `success`, `reward`,
`timestamp`, and `category`; it embeds the synthesized content, stores
`metadata.type = 'reflexion'`, retrieves similar reflexions by vector search,
groups failed reflections into recurring error patterns, and can report an
improvement chain by attempt. Colony gains a task-scoped observation kind for
structured post-failure learning without changing the write path: handoff
expiry, declined quota claims, and failed approaches can become searchable
learning signals instead of prose-only notes. Evidence:
`examples/agentic-flow/src/controllers/reflexion-memory.ts`,
`packages/core/src/task-thread.ts`, `packages/core/src/memory-store.ts`,
`packages/storage/src/types.ts`. Rough effort: medium; schema/type changes plus
three writer call sites and search/render support, but no external runtime.

**Retry/backoff.** Agentic-Flow's `NotificationManager` sends through configured
channels, wraps each send in `sendWithRetry`, uses `maxAttempts`, supports
constant or exponential backoff through `retryPolicy.backoffMs`, and records
audit results. Colony should port the pattern, not the notification subsystem:
bounded retries with deterministic backoff around transient local operations
such as embedding generation, GitHub/CLI polling, or bridge-status refresh.
Colony gains less flaky wave execution while preserving explicit failure
surface area when retries exhaust. Evidence:
`examples/agentic-flow/src/notifications/notification-manager.ts`,
`packages/embedding/src/index.ts`, `packages/core/src/omx-runtime-summary.ts`.
Rough effort: small-to-medium; one shared retry helper and focused adoption at
callers that already have recoverable transient failures.

**ONNX embed provider.** RuVector documents local ONNX embeddings as a
first-class path: local model execution, no API call requirement, default
384-dimensional MiniLM-style embeddings, and direct vector-index integration.
Colony already has an embedding factory with `none`, `local`, `ollama`, and
`openai` providers, plus a local provider backed by `@xenova/transformers` that
loads models lazily, uses a cache directory, quantizes the feature-extraction
pipeline, and knows common model dimensions. Colony gains a clearer
local-by-default embedding story and a compatibility target for wave 4: keep the
existing provider surface, make the local ONNX behavior explicit, and harden
model-cache proof instead of adopting RuVector's vector database stack. Evidence:
`https://github.com/ruvnet/ruvector`, `https://github.com/ruvnet/ruvector/blob/main/README.md`,
`https://github.com/ruvnet/ruvector/tree/main/crates/ruvector-core`,
`packages/embedding/src/index.ts`, `packages/embedding/src/providers/local.ts`,
`packages/embedding/src/types.ts`. Rough effort: small; documentation,
settings validation, and tests around the existing local provider before any
new provider name is considered.

**Observation lineage.** RuVector's RVF material treats lineage and witness
chains as a packaging-level primitive: single-file containers, COW branching,
cryptographic witness records, parent/child derivation chains, and verification
for what was derived from what. Colony should port the observation-lineage idea
at database metadata level, not the RVF container: record parent observation ids,
derived summary ids, compression receipts, task/handoff ancestry, and external
source references so later reads can explain why an observation exists. Colony
gains provenance for compressed summaries, relays, reflexion records, and
embedding-derived ranking without adding a daemon or binary container format.
Evidence: `https://github.com/ruvnet/ruvector`,
`https://github.com/ruvnet/ruvector/tree/main/crates/rvf`,
`packages/storage/src/types.ts`, `packages/core/src/memory-store.ts`,
`docs/architecture.md`, `docs/compression.md`. Rough effort: medium-to-large;
storage metadata conventions can start small, but full query/render support and
backfill tests make this a later wave.

## Out of scope

- Skill composition from Agentic-Flow: Colony already has workflow skills and
  should not import another skill registry or prompt-pack layout.
- Anti-hallucination pipeline from Agentic-Flow/RuVector: too broad for waves
  2-5; Colony needs concrete observation provenance, not a generic safety
  pipeline.
- Severity-based SLA notifications from Agentic-Flow: notification delivery,
  HIPAA checks, channel preferences, and SLA routing are domain infrastructure,
  not Colony's coordination substrate.
- RuVector brain, edge, GNN, SONA, and cluster subsystems: these are complete
  agentic/vector platforms; Colony only needs selected local embedding and
  lineage patterns.
- RuVector RVF runtime/container implementation: useful as lineage inspiration,
  but Colony must not boot services, package kernels, or add RVF as a write-path
  dependency.
- Agentic-Flow medical domain logic: HIPAA and medical notification rules are
  source-domain behavior and do not belong in a general coordination memory
  database.
- Agentic-Flow swarm/agent catalog: Colony's worker discovery is pull-based via
  Queen plans, task readiness, claims, messages, and handoffs.

## Non-negotiables

- Rule 2, compression-at-write: every new observation still flows through
  `MemoryStore.addObservation`, with private redaction, local compression, token
  receipts, and storage in the existing compressed form.
- Rule 8, local-by-default: bridge behavior must work without cloud APIs; local
  embeddings may be enabled, remote providers remain optional, and loopback-only
  readers stay the human surface.
- Rule 10, no daemon on write path: writes must not depend on a background
  worker, RVF runtime, Agentic-Flow MCP server, RuVector service, or external
  process being alive.
- No runtime dependency on Agentic-Flow or RuVector packages: implementations
  may cite their files and URLs, but Colony must keep its own types, storage,
  tests, and release surface.
- Documentation-only source use: do not vendor source from
  `examples/agentic-flow` or `ruvnet/ruvector`; cite it as evidence and port
  only the behavior shape that matches Colony invariants.

## Wave map

- Wave 2, reflexion: add a compressed `reflexion` observation schema and write
  it from existing failure signals; gate on storage/core tests plus visible MCP
  retrieval.
- Wave 3, retry: add bounded retry/backoff for transient bridge operations;
  gate on deterministic retry tests that prove final failure is still surfaced.
- Wave 4, onnx: harden the local ONNX embedding provider path and cache story;
  gate on local provider tests with no network or remote model requirement.
- Wave 5, lineage: record parent/derived observation relationships in metadata;
  gate on query/render tests that show ancestry without expanding every
  observation body.
