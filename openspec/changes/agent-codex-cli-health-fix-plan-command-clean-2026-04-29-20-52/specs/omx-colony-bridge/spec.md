## ADDED Requirements

### Requirement: Execution-Safety Health Recovery Plan

Colony health SHALL provide a guided recovery plan command for execution-safety states involving missing PreToolUse telemetry, stale claims, and live contentions.

#### Scenario: Recovery plan defaults to dry-run

- **GIVEN** Colony health has current execution-safety metrics
- **WHEN** an operator runs `colony health --fix-plan`
- **THEN** the command prints the current health inputs and a recovery plan
- **AND** coordination and queen sweeps are not run
- **AND** the output includes exact verification commands

#### Scenario: Recovery plan suggests lifecycle reinstall when PreToolUse misses dominate

- **GIVEN** `pre_tool_use_missing` is the dominant claim miss reason
- **WHEN** an operator runs `colony health --fix-plan`
- **THEN** the plan suggests reinstalling the affected IDE hooks and restarting the operator session
- **AND** the command does not install hooks itself

#### Scenario: Apply runs sweeps without claim or hook mutation

- **GIVEN** an operator wants the guided recovery sweeps to run
- **WHEN** the operator runs `colony health --fix-plan --apply`
- **THEN** the command runs the coordination sweep and queen sweep
- **AND** the command does not release claims
- **AND** the command does not install hooks
