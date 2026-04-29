## ADDED Requirements

### Requirement: Bridge Claim Policy Is Repo Configurable

The Colony bridge SHALL read a repo-configurable claim policy before deciding
how PreToolUse claim-before-edit results affect execution.

#### Scenario: Warn policy surfaces advisory warnings

- **GIVEN** bridge policy mode is `warn`
- **WHEN** a PreToolUse claim-before-edit result contains a Colony warning
- **THEN** the bridge surfaces the warning to the runtime
- **AND** execution remains allowed

#### Scenario: Block policy denies only strong active claim conflicts

- **GIVEN** bridge policy mode is `block-on-conflict`
- **WHEN** another session owns a strong active claim on the touched file
- **THEN** the bridge denies the tool call with the Colony warning
- **AND** the previous owner keeps the claim
- **WHEN** the claim is absent, weak, stale, or Colony is unavailable
- **THEN** the bridge does not block execution

#### Scenario: Audit-only policy stays silent

- **GIVEN** bridge policy mode is `audit-only`
- **WHEN** a PreToolUse claim-before-edit result is produced
- **THEN** Colony records telemetry
- **AND** the bridge does not surface warnings
- **AND** execution remains allowed

#### Scenario: Conflict result carries policy inputs

- **WHEN** a claim-before-edit result includes a claim conflict
- **THEN** the result includes `conflict`, `conflict_strength`, `owner`, and `warning`
- **AND** policy decisions are derived from those fields rather than hardcoded behavior
