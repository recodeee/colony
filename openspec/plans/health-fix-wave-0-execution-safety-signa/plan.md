# Health-fix Wave 0: execution_safety + signal_evaporation cleanup

Plan slug: `health-fix-wave-0-execution-safety-signa`

## Problem

colony health reports 3 bad readiness areas (execution_safety, queen_plan_readiness, signal_evaporation). claim-before-edit sits at 0% even though pre_tool_use_signals=16 fire correctly — agents skip task_claim_file and the PreToolUse hook does not auto-claim. 22 quota-pending claims block downstream tasks. Ready Queen subtasks (6) go unclaimed because agents call task_ready_for_agent without following up with task_plan_claim_subtask. Sub-fixes: (1) PreToolUse hook auto-claim target file via task_claim_file when no prior claim exists for (repo_root, file). (2) Periodic sweeper releases expired quota-pending claims via task_claim_quota_release_expired. (3) Auto-archive Queen plans when remaining_subtasks=0 stays so for a grace window. (4) Reject or nudge task_ready_for_agent calls that lack a follow-up task_plan_claim_subtask in the same session.

## Acceptance Criteria

- PreToolUse hook auto-claims target file via task_claim_file when no prior claim exists; auto_claimed_before_edit rises above 0
- Hook overhead stays under 150ms p95 budget
- Hook gracefully no-ops when Colony storage is unavailable (no edit blocking)
- Periodic sweeper releases expired quota-pending claims; quota_pending_claim_count trends to 0 in steady state
- Completed Queen plans archive automatically when remaining=0; archived_with_remaining stays 0
- task_ready_for_agent without follow-up task_plan_claim_subtask raises a SessionStart or MCP nudge
- All four sub-fixes have unit + integration tests; pnpm test green

## Roles

- [planner](./planner.md)
- [architect](./architect.md)
- [critic](./critic.md)
- [executor](./executor.md)
- [writer](./writer.md)
- [verifier](./verifier.md)

## Operator Flow

1. Refine this workspace until scope, risks, and tasks are explicit.
2. Publish the plan with `colony plan publish health-fix-wave-0-execution-safety-signa` or the `task_plan_publish` MCP tool.
3. Claim subtasks through Colony plan tools before editing files.
4. Close only when all subtasks are complete and `checkpoints.md` records final evidence.
