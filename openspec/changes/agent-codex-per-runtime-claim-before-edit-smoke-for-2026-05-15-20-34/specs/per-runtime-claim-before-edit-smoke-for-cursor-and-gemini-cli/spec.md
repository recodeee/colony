## ADDED Requirements

### Requirement: Cursor and Gemini CLI claim-before-edit installer smoke coverage
The system SHALL keep per-runtime installer smoke coverage for Cursor and
Gemini CLI that verifies their Colony MCP namespace setup while documenting
that these installers do not yet provide claim-before-edit lifecycle hooks.

#### Scenario: Cursor installer remains MCP-only for claim-before-edit
- **WHEN** the Cursor installer is run
- **THEN** the Cursor MCP config includes `mcpServers.colony`
- **AND** stale `cavemem` entries are removed
- **AND** no `pre-tool-use` or `claim-before-edit` lifecycle hook command is written.

#### Scenario: Gemini CLI installer remains MCP-only for claim-before-edit
- **WHEN** the Gemini CLI installer is run
- **THEN** the Gemini settings include `mcpServers.colony`
- **AND** stale `cavemem` entries are removed
- **AND** no `pre-tool-use` or `claim-before-edit` lifecycle hook command is written.
