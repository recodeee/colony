## ADDED Requirements

### Requirement: Safe Stale Claim Cleanup

Colony coordination sweep SHALL clear non-impact stale claims when no live owner or dirty worktree protects the claim.

#### Scenario: Safe stale claim is released or downgraded

- **GIVEN** a stale claim has no live runtime session
- **AND** no managed worktree has the claimed file dirty on the claimed branch
- **WHEN** `colony coordination sweep --json` runs
- **THEN** expired or weak claims are reported under `released_stale_claims`
- **AND** non-expired stale claims are reported under `downgraded_stale_claims`
- **AND** an audit observation is retained before the active claim row is removed

#### Scenario: Dirty worktree stale claim is skipped

- **GIVEN** a stale claim points at a file dirty in its managed worktree
- **WHEN** `colony coordination sweep --json` runs
- **THEN** the claim is not released
- **AND** the claim is reported under `skipped_dirty_claims`
- **AND** `recommended_actions` tells the operator to use handoff or rescue

#### Scenario: Stale downstream blocker emits rescue action

- **GIVEN** a stale claim blocks downstream Queen plan work
- **WHEN** `colony coordination sweep --json` runs
- **THEN** the blocker remains visible under `stale_downstream_blockers`
- **AND** `recommended_actions` includes the stale blocker rescue command path
