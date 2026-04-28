## ADDED Requirements

### Requirement: Coordination Sweep Command

Colony SHALL provide one read-only sweep command for stale biological
coordination signals.

#### Scenario: inspect stale signals

- **WHEN** a user runs `colony coordination sweep --repo-root <repo>`
- **THEN** Colony reports stale claims, expired handoffs, expired messages,
  decayed proposals below the proposal noise floor, stale hot files, and
  blocked downstream plan tasks
- **AND** the output gives an actionable next step for each reported signal
- **AND** no audit history is deleted

#### Scenario: emit JSON

- **WHEN** a user runs `colony coordination sweep --repo-root <repo> --json`
- **THEN** Colony emits a stable JSON shape with `summary`, `stale_claims`,
  `expired_handoffs`, `expired_messages`, `decayed_proposals`,
  `stale_hot_files`, and `blocked_downstream_tasks`

#### Scenario: dry-run mode

- **WHEN** a user runs `colony coordination sweep --dry-run`
- **THEN** Colony reports the same stale signals without cleanup side effects
- **AND** the command remains safe even if future cleanup options are added
