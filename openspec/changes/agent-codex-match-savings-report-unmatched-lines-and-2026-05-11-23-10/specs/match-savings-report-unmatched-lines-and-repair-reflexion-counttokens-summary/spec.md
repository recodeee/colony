## ADDED Requirements

### Requirement: Savings Report Live Alias Coverage
The savings reference model SHALL map live `savings_report` and `task_list` MCP calls into existing comparison rows so they are not reported as unmatched when present in the live metrics window.

#### Scenario: matching savings_report and task_list calls
- **WHEN** the live comparison model evaluates `savings_report` and `task_list` operation receipts
- **THEN** `savings_report` is matched by the Health/adoption diagnosis row
- **AND** `task_list` is matched by the Ready-work selection row.

### Requirement: Generated Reflexion Field Bounds
Generated reflexion short-text fields SHALL remain within their configured metadata limits without throwing solely because generated text is too long.

#### Scenario: long generated observation summary
- **WHEN** a generated reflexion observation summary exceeds 240 characters
- **THEN** the persisted summary is truncated to 240 characters
- **AND** the reflexion is recorded successfully.
