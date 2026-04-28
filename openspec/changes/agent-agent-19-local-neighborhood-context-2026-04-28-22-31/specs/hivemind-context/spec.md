## ADDED Requirements

### Requirement: Local Neighborhood Context

`hivemind_context` SHALL provide a local neighborhood mode for agents making
edit decisions around their current task and files.

#### Scenario: local mode returns compact nearby traces

- **WHEN** a caller invokes `hivemind_context` with `mode: "local"`, a
  `repo_root`, a `session_id`, and optional `task_id` or `files`
- **THEN** the response includes a compact `local_context`
- **AND** `local_context` includes the current task when it can be resolved
- **AND** claims are limited to the requested files when files are provided
- **AND** pheromone trails and negative pheromones are compact snippets/IDs
- **AND** memory hits and attention blockers are compact snippets/counts/IDs
- **AND** observation bodies require `get_observations`.

#### Scenario: task id can be omitted

- **WHEN** local mode omits `task_id`
- **THEN** the current task is resolved from the requesting `session_id`
- **AND** requested `files` prefer a participating task that already claims
  those files before falling back to the session's generic active task
- **AND** the result remains scoped to the requested repo.
