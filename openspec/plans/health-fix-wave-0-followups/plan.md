# Health-fix Wave 0 follow-ups: quota sweep, plan auto-archive, ready-queue nudge

Plan slug: `health-fix-wave-0-followups`

## Problem

PR #393 closed the PreToolUse auto-materialize gap so claim-before-edit can rise above 0% once new edits flow. Three follow-up health regressions remain on the same wave: (1) expired quota-pending claims are not auto-released, leaving signal_evaporation badge fragile after spike events; (2) completed Queen plans show a recommendation to archive but agents must run `colony plan close` manually — promote to action; (3) agents call task_ready_for_agent without following up with task_plan_claim_subtask (loop adoption 0/116 sessions), leaving Queen subtasks ready-but-unclaimed and queen_plan_readiness bad. Each subtask targets one health metric; together they close the remaining bad readiness areas (execution_safety needs the lifecycle bridge refresh, which is operator-side and out of scope here).

## Acceptance Criteria

- coordination_sweep release-expired-quota CLI exists, releases expired quota-pending claims across repo_roots, emits compact audit summary; quota_pending_claim_count stays at 0 in steady state after sweep
- Completed Queen plans (remaining_subtasks=0) archive automatically after a configurable grace window without an operator running `colony plan close`; archived_with_remaining stays 0; archive conflicts emit plan-archive-blocked
- task_ready_for_agent response includes claim_required=true when claimable subtasks are returned; SessionStart surfaces a one-line hint when previous attention_inbox -> task_ready_for_agent call did not follow up with task_plan_claim_subtask; loop adoption rises above 50% in steady state
- All three subtasks have unit + integration tests; pnpm --filter @colony/core test, pnpm --filter @colony/mcp-server test, pnpm --filter @colony/hooks test, and pnpm --filter @imdeadpool/colony-cli test green
- No regressions to existing claim-before-edit, hivemind_context, or attention_inbox behavior

## Roles

- [planner](./planner.md)
- [architect](./architect.md)
- [critic](./critic.md)
- [executor](./executor.md)
- [writer](./writer.md)
- [verifier](./verifier.md)

## Operator Flow

1. Refine this workspace until scope, risks, and tasks are explicit.
2. Publish the plan with `colony plan publish health-fix-wave-0-followups` or the `task_plan_publish` MCP tool.
3. Claim subtasks through Colony plan tools before editing files.
4. Close only when all subtasks are complete and `checkpoints.md` records final evidence.
