## ADDED Requirements

### Requirement: Managed Worktree Dirty File Contention Report

Colony SHALL provide a command that reports managed agent worktrees editing the
same file.

#### Scenario: Dirty file exists in multiple managed worktrees

- **GIVEN** two managed git worktrees under `.omx/agent-worktrees` or `.omc/agent-worktrees`
- **AND** both worktrees have the same repo-relative file dirty
- **WHEN** `colony worktree contention --json` runs for the repo
- **THEN** the JSON report includes that file under `contentions`
- **AND** the report includes the branches and worktree paths modifying it

#### Scenario: Worktree inventory includes coordination context

- **GIVEN** a managed worktree has dirty files, claimed files, or active session telemetry
- **WHEN** `colony worktree contention --json` runs for the repo
- **THEN** the matching worktree entry includes `branch`, `dirty_files`, `claimed_files`, and `active_session`

### Requirement: Colony Health Live Contention Metrics

Colony health SHALL surface live ownership contention metrics before broad
verification fails on an unstable branch.

#### Scenario: Same-file live claim conflict appears in health output

- **GIVEN** multiple live owners have active claims for the same file
- **WHEN** `colony health` runs
- **THEN** the output includes `live_file_contentions`
- **AND** the top conflicts list includes the file path, owner, session, and branch

#### Scenario: Health JSON includes contention counters

- **GIVEN** live claims, protected-branch claims, stalled lanes, takeover requests, competing worktrees, or dirty contended files exist
- **WHEN** `colony health --json` runs
- **THEN** the JSON includes `live_contention_health`
- **AND** that object includes `live_file_contentions`, `protected_file_contentions`, `paused_lanes`, `takeover_requests`, `competing_worktrees`, and `dirty_contended_files`
