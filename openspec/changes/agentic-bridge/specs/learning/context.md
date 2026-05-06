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

#### Scenario: reflexion record identifies the reviewed work

- **WHEN** an agent records reflexion for a completed, failed, or abandoned
  attempt
- **THEN** the record identifies the source task or handoff, attempt ordinal,
  reviewed action or decision, prior outcome, evidence references, and
  self-critique summary
- **AND** the record remains task-scoped learning evidence rather than a
  replacement for task status, claim ownership, or retry state

#### Scenario: reflexion record captures decision review

- **WHEN** new evidence changes the agent's decision or implementation plan
- **THEN** the record captures the original decision, the reviewed evidence, the
  revised decision, and the confidence or uncertainty that remains
- **AND** reflexion remains separate from unrelated anti-hallucination or skill
  composition systems

#### Scenario: reflexion record materializes follow-up work

- **WHEN** the reflexion wave defines behavior
- **THEN** each actionable lesson identifies its follow-up surface as a task,
  handoff, proposal, message, or no-op with rationale
- **AND** durable follow-up records preserve the source reflexion reference so
  later agents can trace why the work exists

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
