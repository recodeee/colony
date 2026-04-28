# Task Note Working First Write Path

## Problem

Colony health shows working-state notes still split between Colony and OMX
notepad writes. Agents need one clear path that tries `task_note_working` before
legacy notepad writes.

## Change

- Make MCP, AGENTS, and health guidance route working-state saves to
  `task_note_working` first.
- Keep `task_post` guidance for known `task_id` notes and other task-thread
  events.
- Preserve OMX notepad as a fallback or optional pointer-only bridge.
- Strengthen tests proving successful Colony notes do not duplicate full proof
  content into OMX notepad.

## Scope

Guidance, MCP tool descriptions, health hints, and focused test coverage. The
existing pointer bridge remains the implementation path.
