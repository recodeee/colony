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

### Requirement: OMX Status Reads Colony Through One Compact Bridge

Colony SHALL expose a compact bridge status surface for OMX HUD/status display.

#### Scenario: OMX renders coordination state

- **WHEN** OMX needs to render HUD/status state for a session, agent, repo, and
  optional branch
- **THEN** it can call one Colony MCP tool for active lane, attention counts,
  ready-work count and top item, claimed-file preview, latest working-note
  pointer, and next action
- **AND** the response does not include full observation bodies

### Requirement: Fallback Prefers Colony Coordination

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

### Requirement: Bridge Adoption Metrics Compare Runtime And Coordination Use

Colony SHALL expose bridge adoption metrics that show whether OMX is becoming a
runtime/display surface while Colony becomes the primary coordination surface.

#### Scenario: Tool telemetry includes OMX and Colony calls

- **WHEN** local tool telemetry is available
- **THEN** bridge adoption metrics compare `omx_state_get_status` against
  `bridge_status`
- **AND** compare `omx_state_write` against `task_note_working` and `task_post`
- **AND** compare `omx_notepad_write_working` against `task_note_working` and
  `task_post`
- **AND** compare `omx_state_list_active` against `hivemind_context` and
  `hivemind`

#### Scenario: OMX tool telemetry is unavailable

- **WHEN** local telemetry has no OMX tool calls
- **THEN** bridge adoption metrics report the OMX comparison status as
  `unavailable`
- **AND** Colony does not infer fallback replacement ratios from Colony calls
  alone

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
  "hivemind": {
    "lane_count": 1,
    "total_lane_count": 1,
    "lanes_truncated": false,
    "needs_attention_count": 0,
    "counts": {
      "working": 1,
      "thinking": 0,
      "idle": 0,
      "stalled": 0,
      "dead": 0,
      "unknown": 0
    },
    "lane_preview": [
      {
        "branch": "agent/codex/example",
        "task": "Example task",
        "owner": "codex/codex",
        "activity": "working",
        "needs_attention": false,
        "risk": "none",
        "source": "active-session",
        "locked_file_count": 1,
        "locked_file_preview": ["apps/mcp-server/src/tools/bridge.ts"]
      }
    ]
  },
  "branch": "agent/codex/example",
  "task": "Example task",
  "blocker": null,
  "next_action": "No immediate Colony action.",
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
  "attention_counts": {
    "lane_needs_attention_count": 0,
    "pending_handoff_count": 0,
    "pending_wake_count": 0,
    "unread_message_count": 0,
    "stalled_lane_count": 0,
    "recent_other_claim_count": 0,
    "blocked": false
  },
  "ready_work_count": 0,
  "ready_work_preview": [],
  "claimed_file_count": 0,
  "claimed_file_preview": [],
  "claimed_files": [],
  "latest_working_note": null
}
```

#### Scenario: HUD keeps bodies out of the hot path

- **WHEN** `bridge_status` returns blocker or evidence references
- **THEN** it returns compact counts, IDs, and the latest task note preview
- **AND** full observation bodies stay behind `get_observations`.

#### Scenario: HUD renders from compact previews

- **WHEN** OMX needs active-lane, attention, ready-work, and claim state for a
  compact display
- **THEN** `bridge_status` returns `hivemind.lane_preview`,
  `attention_counts`, `ready_work_preview`, `claimed_file_count`,
  `claimed_file_preview`, and `next_action`
- **AND** `next` remains a compatibility alias for `next_action`.

## Anti-Rules

- OMX MUST NOT duplicate Colony task selection or ready-work ranking.
- OMX MUST NOT make `.omx/notepad.md` the primary working-state store when a
  Colony task exists.
- Colony MUST NOT manage shells, launch agents, replace diagnostics, or become
  the HUD runtime.
- Colony telemetry views MUST NOT treat stale OMX process state as durable
  coordination truth without fresh Colony evidence.
