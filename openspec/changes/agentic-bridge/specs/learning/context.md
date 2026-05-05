## ADDED Requirements

### Requirement: Agentic Learning Contracts Are Durable

Colony SHALL keep agentic-bridge learning behavior anchored in OpenSpec before
any reflexion, retry, ONNX, or lineage implementation lands.

#### Scenario: later waves extend the learning contract

- **WHEN** a later wave implements reflexion, retry, ONNX, or lineage behavior
- **THEN** it extends this learning context with concrete requirements and
  scenarios
- **AND** it references Agent 66's pattern catalog at
  `docs/agentic-bridge.md` instead of duplicating the catalog prose

### Requirement: Reflexion Records Have Review Boundaries

Colony SHALL define reflexion as a durable review boundary that captures what an
agent reconsidered, what evidence changed, and what follow-up should be
materialized.

#### Scenario: reflexion wave materializes contracts

- **WHEN** the reflexion wave defines behavior
- **THEN** the spec identifies the durable reflexion record, the reviewed
  decision, the evidence used, and the follow-up handoff or task surface
- **AND** reflexion remains separate from unrelated anti-hallucination or skill
  composition systems

### Requirement: Retry Records Have Attempt Evidence

Colony SHALL define retry as a bounded learning loop with classified failures,
attempt counters, and durable evidence for why another attempt is allowed or
stopped.

#### Scenario: retry wave materializes contracts

- **WHEN** the retry wave defines behavior
- **THEN** the spec identifies the retry budget, failure class, backoff or stop
  rule, and evidence carried into the next attempt
- **AND** retry contracts remain independent from ONNX runtime and lineage
  implementation details until those waves extend the spec
