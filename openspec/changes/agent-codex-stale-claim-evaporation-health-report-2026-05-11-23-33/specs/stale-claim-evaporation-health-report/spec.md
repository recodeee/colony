## ADDED Requirements

### Requirement: Health reports stale-claim evaporation path
The `colony health` JSON payload SHALL include a structured
`stale_claim_evaporation` report derived from signal health and Queen wave
health.

#### Scenario: Stale claims are visible
- **WHEN** stale or expired weak claims exist
- **THEN** `stale_claim_evaporation` reports the stale claim counts, expired weak
  counts, quota pending counts, downstream blocker counts, and exact dry-run,
  safe-release, and blocker-release commands.

#### Scenario: Verbose health output is inspected
- **WHEN** an operator runs `colony health --verbose`
- **THEN** the human report includes a stale claim evaporation section with the
  current status, next action, and coordination sweep commands.

### Requirement: Health hints route stale cleanup through coordination sweep
Health action hints SHALL use the coordination sweep release commands for stale
ownership cleanup instead of generic inbox or Queen sweep advice.

#### Scenario: Safe stale claims are present
- **WHEN** `signal_health.stale_claims` is greater than zero
- **THEN** the stale-claims action hint command is
  `colony coordination sweep --release-safe-stale-claims --json`.

#### Scenario: Stale downstream blockers are present
- **WHEN** `queen_wave_health.stale_claims_blocking_downstream` is greater than
  zero
- **THEN** the downstream blocker action hint command is
  `colony coordination sweep --release-stale-blockers --json`.
