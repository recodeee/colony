# OMX-Colony Bridge Delta

## ADDED Requirements

### Requirement: OMX Status Reads Colony Through One Compact Bridge

Colony SHALL expose a compact bridge status surface for OMX HUD/status display.

#### Scenario: OMX renders coordination state

- **WHEN** OMX needs to render HUD/status state for a session, agent, repo, and
  optional branch
- **THEN** it can call one Colony MCP tool for active lane, attention counts,
  ready-work count and top item, claimed-file preview, latest working-note
  pointer, and next action
- **AND** the response does not include full observation bodies
