## ADDED Requirements

### Requirement: CLI batch release for expired quota-pending claims
The CLI SHALL allow operators to release all TTL-expired quota-pending claims for a repo with `colony task quota-release-expired --all-safe`.

#### Scenario: Batch all safe expired quota claims
- **WHEN** `colony task quota-release-expired --all-safe --repo-root <repo>` is run
- **THEN** the command runs the coordination sweep with expired quota claim release enabled
- **AND** each released quota-pending claim is downgraded to `weak_expired`
- **AND** the command emits a structured summary of released claims.

#### Scenario: All-safe rejects task-specific filters
- **WHEN** `--all-safe` is combined with task-specific quota release options
- **THEN** the command exits with an error instead of mixing batch and targeted release modes.
