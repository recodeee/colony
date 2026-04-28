# OMX-Colony Bridge Specification

## Purpose

This contract defines the boundary between OMX and Colony:

`OMX runs agents; Colony coordinates agents; OMX displays Colony state; Colony consumes OMX telemetry.`

Use this spec when deciding where runtime, coordination, display, or telemetry
work belongs. See `docs/mcp.md` for the MCP startup loop and tool details.

## Requirements

### Requirement: OMX Owns Runtime Surfaces

OMX SHALL own agent runtime, shell orchestration, diagnostics, HUD display, and
local process state.

#### Scenario: Agent runtime needs shell state

- **WHEN** an agent workflow needs to launch, monitor, diagnose, or display a
  local process
- **THEN** OMX owns that runtime surface
- **AND** it may display relevant Colony coordination state without becoming the
  coordination source of truth

### Requirement: Colony Owns Coordination Surfaces

Colony SHALL own coordination, tasks, memory, file claims, inboxes, ready work,
proposals, and handoffs.

#### Scenario: Agent needs work or coordination context

- **WHEN** an agent needs to choose work, inspect ownership, save working state,
  claim files, send a handoff, or read an inbox
- **THEN** it uses Colony first
- **AND** OMX MUST NOT duplicate Colony task selection with a parallel primary
  work queue

### Requirement: Telemetry Flows From OMX Into Colony

Colony SHALL consume OMX telemetry as coordination input, not as a replacement
for Colony task state.

#### Scenario: Runtime telemetry is available

- **WHEN** OMX records active sessions, agent worktree locks, process state, or
  diagnostics that are useful for coordination
- **THEN** Colony may read that telemetry for hivemind and context surfaces
- **AND** Colony keeps coordination decisions in Colony tasks, claims, memory,
  inboxes, proposals, and handoffs

### Requirement: Fallback Prefers Colony Coordination

Agents SHALL use Colony first for coordination and fall back to OMX state or
notepad only when Colony is unavailable or missing the required surface.

#### Scenario: Colony is available

- **WHEN** a Colony task exists or Colony exposes the required coordination tool
- **THEN** working state is recorded through Colony task notes, claims, inboxes,
  or handoffs
- **AND** `.omx/notepad.md` is not the primary working-state store

#### Scenario: Colony is unavailable or incomplete

- **WHEN** the Colony MCP namespace is missing, a tool call fails, or Colony does
  not expose the needed coordination surface
- **THEN** OMX state or notepad may be used as a fallback
- **AND** the fallback record should stay compact enough to migrate back into
  Colony when the surface is restored

### Requirement: Colony Exposes an OMX HUD Status Shape

Colony SHALL expose one compact bridge status payload for OMX HUD and status
overlays so OMX does not parse multiple independent Colony tools.

#### Scenario: OMX renders coordination state

- **WHEN** OMX needs a HUD-sized coordination card for a session
- **THEN** OMX calls the Colony MCP `bridge_status` tool
- **AND** the response uses schema `colony.omx_hud_status.v1`
- **AND** the response includes these top-level fields:

```json
{
  "schema": "colony.omx_hud_status.v1",
  "generated_at": "2026-04-28T21:30:00.000Z",
  "runtime_source": "omx",
  "branch": "agent/codex/example",
  "task": "Example task",
  "blocker": null,
  "next": "No immediate Colony action.",
  "evidence": {
    "task_id": 17,
    "latest_working_note_id": 42,
    "attention_observation_ids": [],
    "attention_observation_ids_truncated": false,
    "hydrate_with": "get_observations"
  },
  "attention": {
    "unread_count": 0,
    "blocking_count": 0,
    "blocking": false,
    "pending_handoff_count": 0,
    "pending_wake_count": 0,
    "stalled_lane_count": 0
  },
  "ready_work_count": 0,
  "ready_work_preview": [],
  "claimed_files": [],
  "latest_working_note": null
}
```

#### Scenario: HUD keeps bodies out of the hot path

- **WHEN** `bridge_status` returns blocker or evidence references
- **THEN** it returns compact counts, IDs, and the latest task note preview
- **AND** full observation bodies stay behind `get_observations`.

## Anti-Rules

- OMX MUST NOT duplicate Colony task selection or ready-work ranking.
- OMX MUST NOT make `.omx/notepad.md` the primary working-state store when a
  Colony task exists.
- Colony MUST NOT manage shells, launch agents, replace diagnostics, or become
  the HUD runtime.
- Colony telemetry views MUST NOT treat stale OMX process state as durable
  coordination truth without fresh Colony evidence.
