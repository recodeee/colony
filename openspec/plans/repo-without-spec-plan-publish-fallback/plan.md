# Allow plan publication for repos without Colony SPEC.md

Plan slug: `repo-without-spec-plan-publish-fallback`

## Problem

Colony ready-task guard stranded multiple recodee static prompt lanes because task_plan_publish and queen_plan_goal fail hard when target repo root lacks SPEC.md. Operators need live Colony plans to be publishable for coordination even when a product repo has OpenSpec but no Colony SPEC.md.

## Acceptance Criteria

- task_plan_publish can publish claimable work for a repo root that lacks SPEC.md, or returns a repairable result that preserves ready-task flow without marking static prompts done.
- queen_plan_goal follows the same behavior and does not strand agents behind OBSERVATION_NOT_ON_TASK for missing SPEC.md alone.
- Existing spec-backed behavior remains intact for repos that do have SPEC.md.
- Focused MCP server tests cover no-SPEC repo publication and ready queue claimability.
- Task #3 records the fix and the PH12 Agent 84 plan can be published/claimed after the Colony repair is available or an exact reload/retry step is recorded.

## Roles

- [planner](./planner.md)
- [architect](./architect.md)
- [critic](./critic.md)
- [executor](./executor.md)
- [writer](./writer.md)
- [verifier](./verifier.md)

## Operator Flow

1. Refine this workspace until scope, risks, and tasks are explicit.
2. Publish the plan with `colony plan publish repo-without-spec-plan-publish-fallback` or the `task_plan_publish` MCP tool.
3. Claim subtasks through Colony plan tools before editing files.
4. Close only when all subtasks are complete and `checkpoints.md` records final evidence.
