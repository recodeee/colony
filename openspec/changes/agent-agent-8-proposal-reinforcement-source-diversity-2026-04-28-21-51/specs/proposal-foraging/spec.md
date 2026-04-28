## ADDED Requirements

### Requirement: Source-Diverse Proposal Strength

Colony SHALL score proposal reinforcement by independent source diversity instead of raw reinforcement event count.

#### Scenario: repeated same-session support

- **GIVEN** a pending proposal already reinforced by session `S`
- **WHEN** session `S` reinforces the same proposal again with the same or weaker kind
- **THEN** the proposal strength is not increased by another full vote

#### Scenario: same agent type different session

- **GIVEN** a pending proposal already has evidence from an agent type
- **WHEN** another session of that same agent type reinforces the proposal
- **THEN** the proposal strength increases by a moderate source-diversity weight

#### Scenario: different agent type rediscovery

- **GIVEN** a pending proposal has evidence from one agent type
- **WHEN** a different agent type reinforces it as `rediscovered`
- **THEN** the proposal receives stronger evidence than explicit support from the same source class

#### Scenario: source-diverse promotion

- **GIVEN** a pending proposal has source-diverse reinforcement whose decayed strength crosses the promotion threshold
- **WHEN** `task_reinforce` evaluates the proposal
- **THEN** Colony promotes the proposal into a task thread
