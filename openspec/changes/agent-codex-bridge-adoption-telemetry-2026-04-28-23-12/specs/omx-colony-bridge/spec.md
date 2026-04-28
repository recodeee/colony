# OMX-Colony Bridge Delta

## ADDED Requirements

### Requirement: Bridge Adoption Metrics Are Visible

Colony SHALL expose local bridge adoption metrics that show whether agents are
moving from OMX coordination fallbacks toward Colony coordination tools.

#### Scenario: Debrief reports bridge conversion

- **WHEN** a user runs `colony debrief --json`
- **THEN** the payload includes `bridge_adoption`
- **AND** it reports `hivemind_context -> attention_inbox` conversion
- **AND** it reports `attention_inbox -> task_ready_for_agent` conversion
- **AND** it reports `task_list` calls without later `task_ready_for_agent`

#### Scenario: Debrief reports OMX fallback replacement

- **WHEN** local tool telemetry includes OMX notepad or state tool calls
- **THEN** bridge adoption metrics compare OMX notepad/status usage against
  Colony working notes and bridge/hivemind status reads
- **AND** when local OMX telemetry is missing, the relevant status is reported
  as `unavailable`
