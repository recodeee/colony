# Proposal

## Why

PostToolUse edit telemetry needs usable file path evidence for claim-before-edit
diagnostics. The current hook stores only one `file_path`, and Bash/apply_patch
write paths are not consistently captured on the main `tool_use` row.

## What

- Store normalized `extracted_paths` arrays on claimable edit telemetry.
- Keep `file_path` and `file_paths` compatibility metadata for existing readers.
- Extract paths for Edit, Write, MultiEdit, NotebookEdit, Bash sed/redirect
  writes, and apply_patch patch headers.
- Filter pseudo device paths before claims or telemetry.
- Add focused Bash/apply_patch extraction tests.

## Impact

- Claim and conflict consumers keep their existing `file_path` compatibility path.
- Multi-file write events expose every touched file through `extracted_paths`.
