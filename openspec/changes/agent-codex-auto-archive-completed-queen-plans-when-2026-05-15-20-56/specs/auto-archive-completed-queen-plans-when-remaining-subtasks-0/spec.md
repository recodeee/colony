## ADDED Requirements

### Requirement: auto-archive-completed-queen-plans-when-remaining-subtasks-0 behavior
The MCP plan system SHALL automatically retry archiving a completed Queen plan
after the default grace window when the final sub-task completion deferred
archival.

#### Scenario: Completion reaches grace window
- **GIVEN** a Queen plan has no remaining incomplete sub-tasks
- **AND** the completion result reports `auto_archive grace period pending`
- **WHEN** the grace window elapses
- **THEN** the system retries the existing three-way archive path automatically
- **AND** records the normal `plan-archived` observation on success.

#### Scenario: Archive retry cannot merge cleanly
- **GIVEN** the automatic grace-window retry reaches a conflicting spec archive
- **WHEN** the three-way archive path reports conflicts
- **THEN** the system records the normal `plan-archive-blocked` observation
- **AND** later explicit archive/list paths can retry after manual repair.
