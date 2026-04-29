# OMX-Colony Bridge Delta

## ADDED Requirements

### Requirement: Auto-Claim Resolves Active Colony Tasks From Runtime Events

Colony SHALL resolve a Codex or OMX hook event to an active Colony task without
requiring the event to always carry an exact participating session id.

Resolution MUST run in this order:

1. exact `session_id`
2. `repo_root` plus `branch`
3. `cwd` or `worktree_path`
4. `agent` plus the latest active task only when there is exactly one match

#### Scenario: Exact session binding wins

- **GIVEN** a session participates in one active Colony task
- **AND** the hook event also carries conflicting repo or branch scope
- **WHEN** auto-claim resolves the active task
- **THEN** Colony binds the event to the exact-session task

#### Scenario: Repo and branch bind an unjoined runtime session

- **GIVEN** a Codex or OMX session is not yet a participant in the task
- **AND** the hook event carries `repo_root` and `branch`
- **WHEN** exactly one active task matches that pair
- **THEN** Colony binds the event and joins the session to that task before
  recording the claim

#### Scenario: Worktree scope binds when branch scope is absent

- **GIVEN** a Codex or OMX event carries `cwd` or `worktree_path`
- **WHEN** exactly one active task matches that filesystem scope
- **THEN** Colony binds the event to that task

#### Scenario: Ambiguous matches do not guess

- **GIVEN** multiple active tasks match the available event scope
- **WHEN** auto-claim resolves the active task
- **THEN** Colony returns `ambiguous`
- **AND** no claim is written
- **AND** the result includes compact candidate task ids, titles, repo roots,
  branches, update timestamps, and active files when cheap

#### Scenario: Missing task returns action guidance

- **GIVEN** no active task matches the event
- **WHEN** auto-claim resolves the active task
- **THEN** Colony returns `not_found`
- **AND** the result suggests creating or binding a task
- **AND** it suggests manually calling `task_claim_file` when the task id is
  already known
