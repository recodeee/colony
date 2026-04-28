## MODIFIED Requirements

### Requirement: Signals Decay Unless Intentionally Durable

Colony SHALL make coordination signals expire, decay, or fall below a noise floor unless they are intentionally durable records.

#### Scenario: stale claims are weak audit records, not active ownership

- **WHEN** a claim is past the configured stale threshold
- **THEN** tools that summarize ownership classify it as stale or expired/weak
- **AND** active ownership counts include only fresh strong claims
- **AND** stale or expired/weak claims remain auditable without producing strong overlap warnings or relay claim inheritance
