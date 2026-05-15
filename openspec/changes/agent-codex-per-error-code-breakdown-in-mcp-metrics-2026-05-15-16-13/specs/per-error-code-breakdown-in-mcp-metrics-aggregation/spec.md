## ADDED Requirements

### Requirement: `savings_report` includes additive per-error-code breakdown
The system SHALL include a `live.error_breakdown` array in `savings_report`
responses that groups live mcp_metrics errors by `error_code` across all
returned operations.

#### Scenario: Error codes aggregate across operations
- **WHEN** multiple operations fail with the same `error_code` in the requested savings window
- **THEN** `live.error_breakdown` includes one row for that code with the summed count
- **AND** that row lists contributing operations with their counts, latest timestamp, and latest message.

#### Scenario: Existing per-operation error reasons remain available
- **WHEN** `savings_report` returns the new `live.error_breakdown`
- **THEN** existing `live.operations[*].error_reasons` fields remain unchanged.
