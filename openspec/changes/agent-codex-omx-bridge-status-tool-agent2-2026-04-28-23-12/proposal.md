# Add OMX bridge status tool

## Why

OMX HUD/status needs one compact Colony call for coordination state. Calling
`omx_state_get_status` or manually chaining Colony tools duplicates Colony
ranking and attention logic.

## What Changes

- Add a `bridge_status` MCP tool for HUD-sized coordination state.
- Compose existing hivemind, attention inbox, and ready-work helpers.
- Keep observation bodies and long memory hits out of the bridge payload.
- Let `task_note_working` optionally append a tiny OMX notepad pointer during
  transition, while keeping Colony task notes primary.

## Impact

- MCP server tool list gains `bridge_status`.
- Existing `hivemind_context`, `attention_inbox`, and `task_ready_for_agent`
  remain the richer source-of-truth surfaces.
- Legacy OMX notepad resume flows can retain a pointer without duplicating full
  working-note proof.
