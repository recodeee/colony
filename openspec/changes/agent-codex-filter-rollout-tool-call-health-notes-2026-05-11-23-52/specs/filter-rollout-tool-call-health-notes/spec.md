## ADDED Requirements

### Requirement: Codex rollout source diagnostics remain non-actionable
The system SHALL keep Codex rollout MCP events available in structured health diagnostics without surfacing their presence as a human health note or review item.

#### Scenario: Rollout MCP events contribute to metrics
- **WHEN** `colony health` reads Codex rollout MCP events in the health window
- **THEN** the structured payload includes those events in the MCP share metrics and source breakdown
- **AND** the human text output does not print a rollout-source note.
