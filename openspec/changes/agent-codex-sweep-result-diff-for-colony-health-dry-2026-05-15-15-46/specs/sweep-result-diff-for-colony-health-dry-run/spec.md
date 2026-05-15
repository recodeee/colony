## ADDED Requirements

### Requirement: health fix-plan dry-run includes coordination sweep diff
`colony health --fix-plan` SHALL run a read-only coordination sweep in dry-run
mode and include a `coordination_sweep_diff` object in JSON output. The diff
SHALL include before counts, projected after counts, projected release and
downgrade counts, and skipped dirty/active/downstream-blocking claim counts.
The dry-run path MUST NOT mutate claims.

#### Scenario: Dry-run shows projected safe-cleanup impact
- **GIVEN** health sees stale, expired/weak, active, dirty, and downstream-blocking claims
- **WHEN** `colony health --fix-plan --json` is run
- **THEN** the response includes `coordination_sweep`
- **AND** the response includes `coordination_sweep_diff.mode="projected"`
- **AND** the diff shows stale and expired/weak counts before and projected after cleanup
- **AND** `safety.mutates_claims=false`

#### Scenario: Text output renders the diff
- **GIVEN** a health fix-plan has `coordination_sweep_diff`
- **WHEN** text output is rendered
- **THEN** the current-health section shows the sweep before/after diff
- **AND** shows skipped dirty, active, and downstream-blocking claim buckets
