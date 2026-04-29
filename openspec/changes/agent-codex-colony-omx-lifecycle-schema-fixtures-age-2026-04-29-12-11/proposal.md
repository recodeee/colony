# Proposal: Shared Colony OMX Lifecycle Contract

## Problem

OMX emits runtime tool lifecycle signals and Colony owns coordination state, but
the two sides need one versioned, transport-neutral envelope so hooks, MCP
consumers, and tests do not drift.

## Scope

- Add `colony-omx-lifecycle-v1` JSON schema.
- Add sanitized fixtures for Codex edit/write tools, Bash, apply_patch, and a
  `/dev/null` pseudo-path.
- Add focused validation tests.

## Non-goals

- No runtime behavior change.
- No hook enforcement change.
- No secrets or full file contents in fixtures.
