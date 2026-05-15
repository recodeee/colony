## ADDED Requirements

### Requirement: Worker archives stale proposed task threads
The worker SHALL archive task rows with `proposal_status='proposed'` once they are older than seven days.

#### Scenario: Old proposed task is archived
- **GIVEN** a task row with `proposal_status='proposed'` and `created_at` more than seven days in the past
- **WHEN** the stale proposal archive job runs
- **THEN** the task row's `proposal_status` is set to `archived`
- **AND** the proposing agent's `open_proposal_count` is decremented without going below zero
- **AND** a `proposal-auto-archived` observation is recorded on the task.

#### Scenario: Fresh proposed task remains proposed
- **GIVEN** a task row with `proposal_status='proposed'` and `created_at` within the last seven days
- **WHEN** the stale proposal archive job runs
- **THEN** the task row remains `proposal_status='proposed'`.

### Requirement: Worker schedules stale proposal archival
The worker runtime SHALL schedule the stale proposal archive job on a six-hour interval and emit structured JSON log lines for each run.

#### Scenario: Scheduled surface logs archive result
- **WHEN** the worker invokes the stale proposal archive job
- **THEN** it emits a JSON log line containing the job name, archived count, and archived task ids.
