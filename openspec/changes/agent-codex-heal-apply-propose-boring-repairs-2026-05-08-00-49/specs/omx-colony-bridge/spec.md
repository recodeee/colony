## ADDED Requirements

### Requirement: Reversible Heal Apply Repairs

Colony SHALL provide a `colony heal` command that proposes and applies low-risk coordination repairs with audit evidence.

#### Scenario: Heal proposes without mutation by default

- **GIVEN** Colony has expired quota-pending claims or protected-branch claims that can be redirected
- **WHEN** an operator runs `colony heal`
- **THEN** the command prints the proposed repair actions
- **AND** no claims are mutated

#### Scenario: Heal apply requires action approval

- **GIVEN** Colony has proposed heal actions
- **WHEN** an operator runs `colony heal --apply`
- **THEN** the command shows each proposed action before applying it
- **AND** the operator can approve or decline each action

#### Scenario: Heal releases expired quota claims

- **GIVEN** a quota-pending claim has passed its handoff expiry
- **WHEN** an operator approves the heal release action
- **THEN** the claim is marked `weak_expired`
- **AND** the linked handoff or relay is marked expired when still pending

#### Scenario: Heal redirects protected branch claims

- **GIVEN** a protected-base task owns an active claim
- **AND** exactly one matching open `agent/*` task in the same repo has the same session as a participant
- **WHEN** an operator approves the heal redirect action
- **THEN** the protected-base claim is released
- **AND** the same file is claimed on the matching agent task

#### Scenario: Heal records searchable repair observations

- **GIVEN** a heal action was applied
- **WHEN** an operator runs `colony search "repair"`
- **THEN** the applied repair action is visible through a stored observation
