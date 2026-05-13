## ADDED Requirements

### Requirement: task_plan_list compact rollup is the default wire shape
The `task_plan_list` MCP handler SHALL accept an optional `detail` argument with values `compact` and `full`, defaulting to `compact`. In compact mode the response SHALL omit `subtasks[].description` and `subtasks[].file_scope` and SHALL include `subtask_count`, `subtask_indexes`, `next_available_count`, and a compact `next_available[]` carrying only `subtask_index`, `title`, `status`, `capability_hint`, `wave_index`, `blocked_by_count`, and `claimed_by_session_id`. In `full` mode the response SHALL be the legacy `PlanInfo[]` shape returned by `listPlans()`.

#### Scenario: Compact default omits heavy sub-task fields
- **WHEN** `task_plan_list` is invoked without `detail`
- **THEN** the response per plan exposes `subtask_indexes`, `next_available_count`, and a compact `next_available[]` whose elements do NOT include `description` or `file_scope`
- **AND** the serialized payload is materially smaller than the `detail: 'full'` shape for the same input.

#### Scenario: Legacy callers can opt back into the full shape
- **WHEN** `task_plan_list` is invoked with `detail: 'full'`
- **THEN** the response per plan includes the original `subtasks: SubtaskInfo[]` and full `next_available: SubtaskInfo[]` arrays unchanged.

### Requirement: task_note_working surfaces nearby tasks when no active match
The `task_note_working` MCP handler SHALL return `nearby_tasks` and a recovery `hint` alongside an `ACTIVE_TASK_NOT_FOUND` error whenever the caller supplied at least one of `repo_root` or `branch` and at least one task in storage matches that filter. Matches SHALL be ranked `branch_and_repo` > `branch_only` > `repo_only`, secondarily by `updated_at` descending, and trimmed to `candidate_limit` (default 10). The handler MUST NOT auto-bind the caller's session to any nearby task.

#### Scenario: Branch-and-repo match is returned to a fresh session
- **GIVEN** a task exists on `repo_root=R`, `branch=B`, and the caller's session has not joined it
- **WHEN** `task_note_working` is called with `session_id=S`, `repo_root=R`, `branch=B`
- **THEN** the response code is `ACTIVE_TASK_NOT_FOUND`
- **AND** `nearby_tasks` includes the task with `match_kind=branch_and_repo`
- **AND** a `hint` references `task_post(task_id=...)` and/or `task_accept_handoff`.

### Requirement: task_plan_claim_subtask attaches recovery hint on race failures
The `task_plan_claim_subtask` MCP handler SHALL attach `plan_slug`, `subtask_counts`, `next_available_count`, `next_available_subtask_index`, and a compact `next_available[]` to the error payload whenever it returns `PLAN_SUBTASK_NOT_AVAILABLE`. `next_available_subtask_index` SHALL be the lowest-indexed sub-task currently in `next_available` for the same plan, excluding the one the caller just tried to claim, or `null` when no claimable sub-task remains.

#### Scenario: Race loser receives the next claimable index
- **GIVEN** a plan with sub-tasks 0, 1, 2 all independently available
- **AND** session A successfully claims sub-task 0
- **WHEN** session B attempts to claim the same sub-task 0
- **THEN** the response is an error with code `PLAN_SUBTASK_NOT_AVAILABLE`
- **AND** `next_available_subtask_index` equals 1
- **AND** `next_available_count` equals 2
- **AND** `next_available[].subtask_index` lists [1, 2].
