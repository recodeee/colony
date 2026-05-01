## MODIFIED Requirements

### Requirement: Alarm Signals Interrupt Normal Pull

Colony SHALL surface blocking coordination signals as attention items before
ordinary ready-work selection.

#### Scenario: blocker is raised

- **WHEN** a message has `urgency: 'blocking'`, a handoff is pending, a wake is
  pending, or a lane is stalled
- **THEN** `attention_inbox` or equivalent startup context surfaces it as an
  alarm signal
- **AND** agents resolve, accept, decline, or relay the alarm before treating
  lower-priority ready work as the next action

#### Scenario: agent starts from one startup panel

- **WHEN** an agent calls `startup_panel` with its session, agent name, and repo
  root
- **THEN** Colony returns a compact resume panel containing active task, ready
  task, inbox count, blocking items, claimed files, blocker, next step,
  evidence, active Queen plan/subtask when present, and stale/quota/runtime
  warnings when present
- **AND** the panel includes `recommended_next_tool`,
  `recommended_next_args`, and copy-paste MCP call text for the highest-priority
  next action
- **AND** blocking inbox items rank before active-lane resume and ready-work
  claims
