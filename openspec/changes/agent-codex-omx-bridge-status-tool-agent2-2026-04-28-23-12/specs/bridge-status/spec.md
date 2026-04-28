## ADDED Requirements

### Requirement: Compact OMX bridge status

The MCP server SHALL expose a `bridge_status` tool that returns HUD-sized
coordination state for one `session_id`, `agent`, and `repo_root`.

#### Scenario: HUD reads one compact coordination payload

- **WHEN** OMX calls `bridge_status`
- **THEN** the result includes `branch`, `task`, `blocker`, `next`,
  `evidence`, `attention`, `ready_work_count`, `claimed_files`, and
  `latest_working_note`
- **AND** the result omits full observation bodies.

#### Scenario: Existing coordination tools remain authoritative

- **WHEN** `bridge_status` computes attention or ready-work state
- **THEN** it composes existing Colony hivemind, attention inbox, and ready-work
  logic instead of reimplementing independent ranking or inbox rules.

### Requirement: Transition working-note pointers

The MCP server SHALL keep Colony task notes primary while allowing conservative
OMX notepad pointers during the transition.

#### Scenario: Colony working note succeeds

- **WHEN** `task_note_working` resolves exactly one active Colony task
- **THEN** it records the full working note as a Colony task note
- **AND** it writes no OMX notepad pointer unless
  `bridge.writeOmxNotepadPointer=true`.

#### Scenario: OMX pointer is written

- **WHEN** an OMX notepad pointer is written
- **THEN** it contains only `branch`, `task`, `blocker`, `next`, `evidence`,
  and `colony_observation_id`
- **AND** it does not copy the full working-note content.

#### Scenario: Active task resolution is not safe

- **WHEN** active task resolution is ambiguous
- **THEN** no OMX fallback pointer is written.

#### Scenario: No active task exists

- **WHEN** no active Colony task matches and the caller sets
  `allow_omx_notepad_fallback=true`
- **THEN** the tool may append the same tiny pointer to OMX notepad with
  `colony_observation_id=unavailable`.

#### Scenario: Bridge status shape remains HUD-sized

- **WHEN** `bridge_status` returns the `colony.omx_hud_status.v1` payload
- **THEN** ready work and claimed files are previews capped for overlay display
- **AND** evidence fields are IDs and hydration hints, not expanded bodies.
