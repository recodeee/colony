## ADDED Requirements

### Requirement: task_note_working materializes explicit branch tasks
The `task_note_working` MCP handler SHALL create or join a Colony task for the
caller when active-task resolution finds zero candidates and the caller supplied
both `repo_root` and `branch`. The handler SHALL join the caller session to that
task, write the working note to Colony, and return a successful response with
`status: "task_materialized"` and the created observation id. The handler MUST
NOT materialize a task when active-task resolution is ambiguous.

#### Scenario: Fresh session joins an existing branch task
- **GIVEN** a Colony task exists for `repo_root=R` and `branch=B`
- **AND** session `S` has not joined that task
- **WHEN** `task_note_working` is called with `session_id=S`, `repo_root=R`, and `branch=B`
- **THEN** the handler joins `S` to the existing task
- **AND** posts the working note to that task
- **AND** returns `status: "task_materialized"` instead of `ACTIVE_TASK_NOT_FOUND`

#### Scenario: Fresh session creates a branch task
- **GIVEN** no Colony task exists for `repo_root=R` and `branch=B`
- **WHEN** `task_note_working` is called with `session_id=S`, `repo_root=R`, and `branch=B`
- **THEN** the handler creates a task for `R` and `B`
- **AND** joins `S` to the new task
- **AND** posts the working note to the new task
- **AND** returns `status: "task_materialized"` instead of `ACTIVE_TASK_NOT_FOUND`
