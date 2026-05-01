## ADDED Requirements

### Requirement: Quota-Pending Claim Resolution Tools

Colony MCP SHALL provide direct tools for resolving quota-pending file claims without leaving the claim row as an active blocker.

#### Scenario: Replacement accepts quota-pending ownership

- **GIVEN** a quota relay or quota-exhausted handoff has weakened one or more file claims to `handoff_pending`
- **WHEN** an eligible replacement session calls `task_claim_quota_accept`
- **THEN** the linked quota-pending claims are transferred to the replacement session as active claims
- **AND** the linked relay or handoff is marked accepted
- **AND** an audit note is written to the task timeline

#### Scenario: Receiver declines without hiding work from others

- **GIVEN** a quota relay or quota-exhausted handoff is still pending
- **WHEN** an eligible receiver calls `task_claim_quota_decline`
- **THEN** the decline reason is recorded
- **AND** the linked relay or handoff remains pending and visible to other eligible agents
- **AND** quota-pending claim ownership is not transferred to the declining session

#### Scenario: Expired quota-pending claim is downgraded

- **GIVEN** a quota-pending claim has passed its expiry time
- **WHEN** a task participant calls `task_claim_quota_release_expired`
- **THEN** the claim state is downgraded to `weak_expired`
- **AND** the claim no longer counts as a quota-pending active blocker
- **AND** audit history remains available through the task timeline
