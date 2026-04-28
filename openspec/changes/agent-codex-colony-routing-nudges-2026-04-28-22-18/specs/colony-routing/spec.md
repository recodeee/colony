## ADDED Requirements

### Requirement: Hivemind Context Routes Agents To Active Coordination

`hivemind_context` SHALL include a summary next action that tells agents to call `attention_inbox`, then `task_ready_for_agent`, before choosing work.

#### Scenario: Context response includes routing hints

- **WHEN** an agent calls `hivemind_context`
- **THEN** the response summary includes `suggested_tools` containing `attention_inbox` and `task_ready_for_agent`
- **AND** the response includes compact attention counts and hydration guidance for `attention_inbox`

### Requirement: Task List Remains Inventory

`task_list` SHALL return task inventory with a non-blocking hint that `task_ready_for_agent` is the work-selection tool.

#### Scenario: Repeated task list use strengthens the hint

- **GIVEN** a session has already called `task_list`
- **AND** the session has not called `task_ready_for_agent`
- **WHEN** it calls `task_list` again
- **THEN** the response includes the hint `task_list is inventory. Use task_ready_for_agent to choose claimable work.`

### Requirement: Working Notes Do Not Require Task IDs

Colony SHALL provide a tool for writing task-scoped working notes without requiring the caller to know `task_id`.

#### Scenario: Active task note

- **GIVEN** a session is participating in an active task
- **WHEN** it calls `task_note_working` with `session_id` and `content`
- **THEN** Colony posts a `note` on the active task
- **AND** returns `task_id` and `observation_id`

#### Scenario: Ambiguous note target

- **GIVEN** more than one task matches the supplied scope
- **WHEN** the caller omits the branch
- **THEN** Colony returns compact candidate tasks instead of guessing

### Requirement: Health Shows Adoption Thresholds

`colony health` SHALL report good and bad adoption threshold signals for routing behavior.

#### Scenario: Bad adoption patterns are visible

- **WHEN** `task_list` outnumbers `task_ready_for_agent`
- **OR** notepad working writes outnumber Colony task notes
- **OR** `attention_inbox` or `task_ready_for_agent` is unused
- **THEN** `colony health` marks the corresponding adoption threshold as `bad`
