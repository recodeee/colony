## MODIFIED Requirements

### Requirement: MCP Metrics Receipts

Colony SHALL record and report compact MCP tool-call receipts without storing
raw request or response bodies in the aggregate metrics view.

#### Scenario: focused operation report exposes success and failure cost

- **WHEN** `colony gain --operation <name>` is run for an operation with both
  successful and failed MCP calls
- **THEN** the focused operation detail reports success-token and error-token
  totals
- **AND** reports average success and error tokens per call class
- **AND** reports peak input, output, total token, and duration values for that
  operation
- **AND** does not include raw tool argument or response bodies.
