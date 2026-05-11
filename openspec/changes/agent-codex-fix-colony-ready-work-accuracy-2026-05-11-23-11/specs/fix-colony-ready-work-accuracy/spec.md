## ADDED Requirements

### Requirement: Stranded plan subtask rescue requeues ready work
The system SHALL append an auditable `available` plan lifecycle marker when
stranded rescue releases a dead owner's claims for a Queen plan subtask that is
still marked claimed by that owner.

#### Scenario: Released upstream subtask becomes claimable again
- **GIVEN** a Queen plan subtask is `claimed` by a stranded session
- **AND** a later subtask depends on it
- **WHEN** bulk stranded rescue releases the stranded session's claims
- **THEN** the claimed subtask is requeued as `available`
- **AND** `task_ready_for_agent` can surface the subtask as ready work again
- **AND** the rescue audit records which plan subtasks were requeued

#### Scenario: Completed subtasks stay terminal
- **GIVEN** a Queen plan subtask has a completed lifecycle marker
- **WHEN** stranded rescue releases old claims for the same task
- **THEN** Colony SHALL NOT replace the completed status with available.

### Requirement: MCP stranded rescue handles dead sessions
The MCP stranded rescue tools SHALL use the bulk stranded cleanup path so
sessions that are no longer live but still hold claims can be scanned and
released from MCP.

#### Scenario: Confirmed MCP rescue releases stale claims
- **GIVEN** a dead or inactive session holds task file claims
- **WHEN** `rescue_stranded_run` is called with `confirm: true`
- **THEN** the claims are released
- **AND** a `rescue-stranded` audit observation is written
- **AND** the response returns the rescued session summary.
