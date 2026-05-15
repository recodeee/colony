## ADDED Requirements

### Requirement: reject-task-ready-for-agent-without-follow-up-task-plan-claim-subtask behavior
The ready queue SHALL keep a per-session claim obligation when it returns a
claimable plan sub-task with `claim_required=true`.

#### Scenario: Session reads ready queue twice without claiming
- **GIVEN** `task_ready_for_agent` returned a claimable sub-task for a session
- **AND** that session has not called `task_plan_claim_subtask`
- **WHEN** the same session calls `task_ready_for_agent` again while the sub-task is still available
- **THEN** the response repeats the same `task_plan_claim_subtask` arguments
- **AND** the response explains that the prior ready result must be claimed before reading again.

#### Scenario: Session starts with a pending ready claim
- **GIVEN** a session has an unfulfilled ready-claim obligation
- **WHEN** SessionStart renders the ready-claim nudge
- **THEN** the nudge names the pending plan/sub-task
- **AND** instructs the agent to call `task_plan_claim_subtask` before reading the queue again.
