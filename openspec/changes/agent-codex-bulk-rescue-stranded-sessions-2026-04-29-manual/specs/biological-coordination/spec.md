## MODIFIED Requirements

### Requirement: Trail pruning

Colony SHALL prune trails through rescue, sweep, archive, and completion helpers without deleting audit observations.

#### Scenario: bulk stranded rescue dry-run

- **WHEN** an operator runs `colony rescue stranded --older-than <duration> --dry-run`
- **THEN** Colony lists each stranded session with `session_id`, `agent`, `repo_root`, `branch`, `last_activity`, held claim count, and suggested action
- **AND** no claim rows, session rows, or audit observations are mutated

#### Scenario: bulk stranded rescue apply

- **WHEN** an operator runs `colony rescue stranded --older-than <duration> --apply`
- **THEN** Colony releases claim rows held by each matching stranded session
- **AND** Colony marks each matching session rescued by ending the session
- **AND** Colony emits a `rescue-stranded` audit observation that records released claims and task ids
- **AND** historical observations remain stored and searchable
