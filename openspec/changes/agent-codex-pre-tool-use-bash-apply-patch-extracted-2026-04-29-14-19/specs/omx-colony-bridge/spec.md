## ADDED Requirements

### Requirement: PreToolUse Extracted Paths

The Colony bridge SHALL expose normalized `extracted_paths` for claimable
Bash and apply_patch PreToolUse events before the tool executes.

#### Scenario: Bash write commands expose pre-execution paths

- **GIVEN** PreToolUse receives a Bash command with a redirect, in-place
  sed/perl edit, or tee output
- **WHEN** the targets can be parsed without command substitution
- **THEN** the hook result includes every normalized claimable file path in
  `extracted_paths`
- **AND** the files are claimable before PostToolUse records a tool_use row

#### Scenario: apply_patch exposes patch targets before execution

- **GIVEN** PreToolUse receives an apply_patch-style tool call
- **WHEN** the patch contains add, update, delete, or move file headers, or the
  sanitized lifecycle payload contains target paths
- **THEN** the hook result includes every normalized claimable target path in
  `extracted_paths`

#### Scenario: pseudo paths are omitted

- **GIVEN** a parsed path is `/dev/null`, stdout, stderr, empty, or a command
  code fragment
- **WHEN** the PreToolUse extractor builds claim candidates
- **THEN** that path is omitted from `extracted_paths` and from auto-claims
