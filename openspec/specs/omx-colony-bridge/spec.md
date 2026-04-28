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

## Anti-Rules

- OMX MUST NOT duplicate Colony task selection or ready-work ranking.
- OMX MUST NOT make `.omx/notepad.md` the primary working-state store when a
  Colony task exists.
- Colony MUST NOT manage shells, launch agents, replace diagnostics, or become
  the HUD runtime.
- Colony telemetry views MUST NOT treat stale OMX process state as durable
  coordination truth without fresh Colony evidence.
