## ADDED Requirements

### Requirement: Lifecycle Mutation Envelopes Produce Measurable Edit Telemetry

Codex/OMX PreToolUse and PostToolUse lifecycle envelopes SHALL become measurable
claim-before-edit and tool-use observations when their inputs include claimable
repository file paths.

#### Scenario: PreToolUse records claim-before-edit before mutation

- **GIVEN** a lifecycle PreToolUse envelope for Write, MultiEdit, apply_patch, or Patch
- **WHEN** the tool input includes `file_path`, `path`, `paths[].path`, or patch file headers
- **THEN** Colony records a `claim-before-edit` observation before the edit
- **AND** stores normalized repo-relative paths in `extracted_paths`

#### Scenario: PostToolUse records edit telemetry after mutation

- **GIVEN** a lifecycle PostToolUse envelope for Write, MultiEdit, apply_patch, or Patch
- **WHEN** the tool input includes a claimable repository file path
- **THEN** Colony records a `tool_use` observation with `file_path`, `file_paths`, and `extracted_paths`

#### Scenario: Unclaimable paths are skipped

- **GIVEN** a lifecycle mutation envelope references a pseudo path, directory, or known out-of-repo absolute path
- **WHEN** path normalization evaluates the target
- **THEN** Colony omits that path from claim-before-edit and tool-use file metadata

#### Scenario: Path extraction failures remain observable

- **GIVEN** a lifecycle mutation envelope has no claimable file path
- **WHEN** Colony cannot extract a path from the tool input
- **THEN** Colony records warning metadata on the lifecycle/tool telemetry
- **AND** PreToolUse contributes a `claim-before-edit` warning signal for health diagnostics
