## ADDED Requirements

### Requirement: Ready Queue Empty-State Plan Hint
When `task_ready_for_agent` returns an empty ready queue but a published plan still contains an unclaimed sub-task, the response SHALL include an optional `hint` object for that sub-task without changing the existing empty-state fields.

#### Scenario: Blocked plan work remains discoverable
- **GIVEN** a published plan has no ready claimable rows because the remaining unclaimed sub-task is blocked by an upstream dependency
- **WHEN** an executor calls `task_ready_for_agent`
- **THEN** the response still has `ready: []` and the existing `empty_state`
- **AND** the response includes `hint.plan_slug`, `hint.subtask_index`, `hint.blocked_by_count`, and `hint.blocked_by`
- **AND** `hint.claim_args` contains the exact `task_plan_claim_subtask` arguments for the unclaimed sub-task
- **AND** `hint.codex_mcp_call` contains the matching Codex MCP call string.
