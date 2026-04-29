# OMX-Colony Bridge Spec Delta

## ADDED Requirements

### Requirement: Shared Lifecycle Envelope

Colony and OMX SHALL share the versioned `colony-omx-lifecycle-v1` lifecycle
envelope for runtime events that become coordination inputs.

#### Scenario: runtime event is emitted

- **WHEN** OMX emits a lifecycle event for Colony to consume
- **THEN** the event validates against
  `packages/contracts/schemas/colony-omx-lifecycle-v1.schema.json`
- **AND** the event includes `event_id`, `event_name`, `session_id`, `agent`,
  `cwd`, `repo_root`, `branch`, `timestamp`, and `source`
- **AND** `event_name` is one of `session_start`, `task_bind`,
  `pre_tool_use`, `post_tool_use`, `claim_result`, `stop_intent`, or
  `finish_result`

#### Scenario: tool event is emitted

- **WHEN** the lifecycle event is `pre_tool_use` or `post_tool_use`
- **THEN** the envelope includes `tool_name` and sanitized `tool_input`
- **AND** `tool_input` summarizes paths, operation, command, and counts without
  secrets or full file contents

#### Scenario: event is retried

- **WHEN** OMX retries delivery of the same logical event
- **THEN** `event_id` stays stable
- **AND** Colony deduplicates repeated `event_id` deliveries

#### Scenario: post tool event follows a pre tool event

- **WHEN** `post_tool_use` records a tool result
- **THEN** it is linkable to the matching `pre_tool_use` by `parent_event_id`
  or by a producer-defined shared `event_id`
- **AND** distinct `post_tool_use` event ids SHOULD set `parent_event_id` to
  the pre event id

#### Scenario: warning or result is returned

- **WHEN** a lifecycle consumer returns a warning or result
- **THEN** the response shape contains `status`, `code`, `message`,
  `next_action`, and `candidates`
- **AND** `status` is `ok`, `warning`, or `error`

#### Scenario: patch creates or deletes a file

- **WHEN** a tool input references `/dev/null`
- **THEN** the path is represented with `kind: "pseudo"` and
  `pseudo: "dev_null"`
- **AND** consumers do not treat `/dev/null` as a claimable repo file
