## ADDED Requirements

### Requirement: Ordered Wave MCP Plans

Colony SHALL let MCP callers publish task plans with explicit ordered wave hints.

#### Scenario: publish explicit waves through MCP

- **WHEN** an agent calls `task_plan_publish` with flat `subtasks` and ordered `waves` or `ordering_hints.waves`
- **THEN** Colony publishes one claimable subtask per ordered item
- **AND** subtasks in later waves depend on the previous wave
- **AND** the MCP response includes `plan_slug`, `waves`, subtask indexes, and `claim_instructions`

#### Scenario: preserve flat publish behavior

- **WHEN** an agent calls `task_plan_publish` without wave hints
- **THEN** Colony preserves the supplied subtask order and dependency behavior
