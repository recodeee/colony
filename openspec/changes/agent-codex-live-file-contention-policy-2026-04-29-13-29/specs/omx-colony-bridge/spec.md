## ADDED Requirements

### Requirement: Live File Contention Policy Signal

The Colony bridge SHALL emit `LIVE_FILE_CONTENTION` when PreToolUse detects
another session's file claim on the touched path.

#### Scenario: Default warn mode remains advisory

- **GIVEN** bridge policy mode is `warn`
- **WHEN** PreToolUse detects `LIVE_FILE_CONTENTION`
- **THEN** the runtime bridge receives an allow result with warning context

#### Scenario: Block mode denies strong live contention

- **GIVEN** bridge policy mode is `block-on-conflict`
- **WHEN** PreToolUse detects `LIVE_FILE_CONTENTION`
- **AND** the contention strength is `strong`
- **THEN** the runtime bridge receives a deny result
- **AND** the previous owner keeps the claim

#### Scenario: Weak and expired claims do not block

- **GIVEN** bridge policy mode is `block-on-conflict`
- **WHEN** PreToolUse detects `LIVE_FILE_CONTENTION`
- **AND** the contention strength is `weak`
- **THEN** the runtime bridge receives an allow result
- **AND** the editing session can claim the file

#### Scenario: Audit-only stays silent

- **GIVEN** bridge policy mode is `audit-only`
- **WHEN** PreToolUse detects `LIVE_FILE_CONTENTION`
- **THEN** Colony records telemetry
- **AND** the runtime bridge receives no warning context or deny result
