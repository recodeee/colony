## MODIFIED Requirements

### Requirement: Agents Pull Work By Response Threshold

Colony SHALL expose ready work for agents to pull, ranked by fit and current local context.

#### Scenario: inventory tool routes callers to ready work

- **WHEN** an agent calls `task_list`
- **THEN** the response includes task inventory without removing task data
- **AND** the response includes `coordination_warning: "task_list is inventory. Use task_ready_for_agent to choose claimable work."`
- **AND** the response includes `next_tool: "task_ready_for_agent"`

#### Scenario: repeated task inventory browsing gets a stronger warning

- **WHEN** telemetry shows the same session repeatedly calling `task_list` without a later `task_ready_for_agent` call
- **THEN** the `task_list` response includes `coordination_warning: "Stop browsing. Call task_ready_for_agent before selecting work."`
- **AND** the response remains backward-compatible and does not block `task_list`
