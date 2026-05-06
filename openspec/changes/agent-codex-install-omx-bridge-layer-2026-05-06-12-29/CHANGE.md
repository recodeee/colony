---
base_root_hash: 3bfe1540
slug: agent-codex-install-omx-bridge-layer-2026-05-06-12-29
---

# CHANGE · agent-codex-install-omx-bridge-layer-2026-05-06-12-29

## §P  proposal
Add installer support so Colony copies detected OMX MCP servers into target IDE configs when an existing system OMX layer is present.

## §S  delta
op|target|row
-|-|-
add|T|T2 todo When Colony install detects an existing system OMX MCP layer, it installs the detected OMX MCP server entries into the target IDE config alongside Colony without deleting user servers. -

## §T  tasks
id|status|task|cites
-|-|-|-
T1|done|Add installer helper that detects existing system OMX MCP server entries and returns portable server configs.|T2
T2|done|Wire every IDE installer to copy missing detected OMX MCP servers alongside Colony without removing unrelated servers.|T2
T3|done|Cover detected OMX layer install, non-OMX exclusion, and existing target override preservation in installer tests.|T2
T4|done|Run focused installer verification and OpenSpec validation before finish.|T2

## §E  evidence
- `pnpm --filter @colony/installers test`: 19 passed
- `pnpm --filter @colony/installers typecheck`: passed
- `pnpm exec biome check packages/installers/src packages/installers/test openspec/changes/agent-codex-install-omx-bridge-layer-2026-05-06-12-29/CHANGE.md`: passed
- `openspec validate --specs`: 2 passed, 0 failed

## §B  bugs
id|status|task|cites
-|-|-|-
