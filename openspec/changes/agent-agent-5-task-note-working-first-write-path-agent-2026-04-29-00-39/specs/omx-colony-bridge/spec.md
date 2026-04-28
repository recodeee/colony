# OMX-Colony Bridge Delta

## MODIFIED Requirements

### Requirement: Colony Is Primary For Coordination State

Agents SHALL use Colony first for coordination and fall back to OMX state or
notepad only when Colony is unavailable or missing the required surface.

#### Scenario: Colony is available

- **WHEN** a Colony task exists or Colony exposes the required coordination tool
- **THEN** working state is first written through `task_note_working` when the
  caller needs active-task resolution
- **AND** working state may use `task_post kind="note"` when the `task_id` is
  already known
- **AND** claims, inboxes, and handoffs use Colony coordination surfaces
- **AND** `.omx/notepad.md` is not the primary working-state store
- **AND** successful Colony working-note writes do not duplicate full note
  content into `.omx/notepad.md`
- **AND** an optional OMX notepad pointer contains only `branch`, `task`,
  `blocker`, `next`, `evidence`, and `colony_observation_id`

#### Scenario: Colony is unavailable or incomplete

- **WHEN** the Colony MCP namespace is missing, a tool call fails, or Colony does
  not expose the needed coordination surface
- **THEN** OMX state or notepad may be used as a fallback
- **AND** the fallback record should stay compact enough to migrate back into
  Colony when the surface is restored
- **AND** `ACTIVE_TASK_NOT_FOUND` may fall back to an OMX pointer only when the
  caller explicitly enables fallback
