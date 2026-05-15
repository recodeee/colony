## ADDED Requirements

### Requirement: `colony gain` renders configured USD costs by default
The system SHALL render USD cost information in `colony gain` default live
table and compact summary output when input/output USD-per-1M-token rates are
configured through CLI flags or environment variables, without requiring an
additional flag.

#### Scenario: Summary view includes configured USD cost
- **WHEN** `colony gain --summary` runs with configured input and output cost rates
- **THEN** the headline includes total and average USD cost
- **AND** the By Operation table includes per-operation USD cost.

#### Scenario: No-cost escape hatch suppresses configured USD cost
- **WHEN** `colony gain --no-cost` runs while cost rates are configured
- **THEN** the command does not pass cost rates into the metrics aggregate
- **AND** rendered output follows the token-only, unconfigured-cost path.
