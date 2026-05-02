# Proposal

## Why

Codex/OMX lifecycle health can report the bridge as available while showing no
recent edit paths or PreToolUse signals. Lifecycle ingestion must convert
mutation envelopes into measurable claim-before-edit and tool-use telemetry,
including warning evidence when a mutation payload has no claimable path.

## What

- Normalize direct and structured tool input paths from Codex/OMX envelopes.
- Persist PreToolUse as `claim-before-edit` telemetry before mutation.
- Persist PostToolUse as `tool_use` telemetry after mutation.
- Filter pseudo, directory, and out-of-repo paths through claim-path helpers.
- Add warning metadata when path extraction fails.
- Extend focused lifecycle/path tests.

## Impact

Health and coordination diagnostics can distinguish missing lifecycle hooks from
path extraction failures, and successful lifecycle edits produce repo-relative
paths usable by claim coverage checks.
