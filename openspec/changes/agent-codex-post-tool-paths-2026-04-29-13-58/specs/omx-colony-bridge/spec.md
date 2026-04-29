## ADDED Requirements

### Requirement: Claimable Tool Telemetry Extracted Paths

The Colony bridge SHALL store normalized `extracted_paths` arrays on claimable
PostToolUse edit telemetry.

#### Scenario: Direct edit tools expose extracted paths

- **GIVEN** PostToolUse receives Edit, Write, MultiEdit, or NotebookEdit input
- **WHEN** the input contains a claimable file path
- **THEN** the `tool_use` telemetry metadata includes `extracted_paths`
- **AND** pseudo device paths are omitted

#### Scenario: Bash write commands expose extracted paths

- **GIVEN** PostToolUse receives a Bash command with an in-place sed edit or
  stdout redirect
- **WHEN** the paths can be parsed without command substitution
- **THEN** the `tool_use` telemetry metadata includes every normalized touched
  file path in `extracted_paths`

#### Scenario: apply_patch exposes patch file headers

- **GIVEN** PostToolUse receives an apply_patch-style tool call
- **WHEN** the patch contains add, update, delete, or move file headers
- **THEN** the `tool_use` telemetry metadata includes every normalized claimable
  patch path in `extracted_paths`
