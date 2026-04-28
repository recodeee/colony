## ADDED Requirements

### Requirement: Ready Queue Gives Claim Guidance

Colony SHALL make `task_ready_for_agent` explicit about whether a plan subtask
can be claimed.

#### Scenario: claimable subtask

- **GIVEN** a plan has an available subtask for the caller
- **WHEN** the agent calls `task_ready_for_agent`
- **THEN** the response includes `next_tool: "task_plan_claim_subtask"`
- **AND** the response includes top-level `plan_slug` and `subtask_index`
- **AND** the response includes `claim_args` with `plan_slug`,
  `subtask_index`, `session_id`, and `agent`

#### Scenario: no claimable plan subtasks

- **GIVEN** no plan subtasks are currently claimable by the caller
- **WHEN** the agent calls `task_ready_for_agent`
- **THEN** the response includes `empty_state: "No claimable plan subtasks. Publish a Queen/task plan for multi-agent work, or use task_list only for browsing."`
- **AND** the response does not fabricate claim arguments

#### Scenario: future subtasks are blocked

- **GIVEN** a plan has future subtasks but their dependencies are not completed
- **AND** no other plan subtask is claimable
- **WHEN** the agent calls `task_ready_for_agent`
- **THEN** the response includes the same no-claimable-subtasks `empty_state`
- **AND** the response does not include `next_tool`
