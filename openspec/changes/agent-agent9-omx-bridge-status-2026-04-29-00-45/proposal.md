# Proposal

## Problem

OMX status/HUD surfaces need Colony coordination state but should not call the
full startup loop every render. Today the compact state lives across
`hivemind_context`, `attention_inbox`, `task_ready_for_agent`, and task-note
timeline reads.

## Change

Add a `bridge_status` MCP tool that returns active lane, attention counts,
ready-work count/top item, claimed-file preview, latest working-note pointer,
and next action from one compact call.

## Scope

- MCP tool registration and implementation.
- Ready-work helper reuse for the new bridge surface.
- Focused MCP tests with `.omx/state/active-sessions/*.json` fixture data.
- MCP/README/OpenSpec documentation.
