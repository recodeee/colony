# Finish Colony execution-safety loop

Plan slug: `finish-colony-execution-safety-loop`

## Problem

Coordination adoption is green, but claim-before-edit diagnostics and Queen plan execution are red. Health must explain why claims do not count before edits, and active plan work must become claimable through task_ready_for_agent.

## Acceptance Criteria

- claim/edit correlation diagnostics explain why task_claim_file calls do not count before edits.
- active plan exists with claimable subtasks.
- task_ready_for_agent returns task_plan_claim_subtask args for ready work.
- task_plan_claim_subtask is used for the active execution-safety lane.
- targeted tests cover claim miss diagnostics, path normalization, fallback matching, bridge signal distinctions, and Queen readiness.

## Roles

- [planner](./planner.md)
- [architect](./architect.md)
- [critic](./critic.md)
- [executor](./executor.md)
- [writer](./writer.md)
- [verifier](./verifier.md)

## Operator Flow

1. Refine this workspace until scope, risks, and tasks are explicit.
2. Publish the plan with `colony plan publish finish-colony-execution-safety-loop` or the `task_plan_publish` MCP tool.
3. Claim subtasks through Colony plan tools before editing files.
4. Close only when all subtasks are complete and `checkpoints.md` records final evidence.
