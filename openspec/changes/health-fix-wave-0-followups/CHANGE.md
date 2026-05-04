---
base_root_hash: 3bfe1540
slug: health-fix-wave-0-followups
---

# CHANGE · health-fix-wave-0-followups

## §P  proposal
# Health-fix Wave 0 follow-ups: quota sweep, plan auto-archive, ready-queue nudge

## Problem

PR #393 closed the PreToolUse auto-materialize gap so claim-before-edit can rise above 0% once new edits flow. Three follow-up health regressions remain on the same wave: (1) expired quota-pending claims are not auto-released, leaving signal_evaporation badge fragile after spike events; (2) completed Queen plans show a recommendation to archive but agents must run `colony plan close` manually — promote to action; (3) agents call task_ready_for_agent without following up with task_plan_claim_subtask (loop adoption 0/116 sessions), leaving Queen subtasks ready-but-unclaimed and queen_plan_readiness bad. Each subtask targets one health metric; together they close the remaining bad readiness areas (execution_safety needs the lifecycle bridge refresh, which is operator-side and out of scope here).

## Acceptance criteria

- coordination_sweep release-expired-quota CLI exists, releases expired quota-pending claims across repo_roots, emits compact audit summary; quota_pending_claim_count stays at 0 in steady state after sweep
- Completed Queen plans (remaining_subtasks=0) archive automatically after a configurable grace window without an operator running `colony plan close`; archived_with_remaining stays 0; archive conflicts emit plan-archive-blocked
- task_ready_for_agent response includes claim_required=true when claimable subtasks are returned; SessionStart surfaces a one-line hint when previous attention_inbox -> task_ready_for_agent call did not follow up with task_plan_claim_subtask; loop adoption rises above 50% in steady state
- All three subtasks have unit + integration tests; pnpm --filter @colony/core test, pnpm --filter @colony/mcp-server test, pnpm --filter @colony/hooks test, and pnpm --filter @imdeadpool/colony-cli test green
- No regressions to existing claim-before-edit, hivemind_context, or attention_inbox behavior

## Sub-tasks

### Sub-task 0: Sweep expired quota-pending claims via coordination_sweep

Add a periodic sweep that calls task_claim_quota_release_expired for every quota-pending claim past TTL across all repo_roots in the local DB. Exposed as `colony coordination sweep --release-expired-quota` and optionally fired from session-start when verbose. Output a compact audit summary (count released, top tasks, oldest age).

File scope: packages/core/src/coordination-sweep.ts, packages/core/src/scoped-claim.ts, apps/cli/src/commands/coordination.ts

### Sub-task 1: Auto-archive completed Queen plans when remaining_subtasks=0

When a plan has remaining_subtasks=0 and stays so for a grace window (default 60s), call spec_archive automatically and emit a plan-archive observation. Health currently emits a recommendation for this — promote it to action. Block on conflicts; record plan-archive-blocked observation when three_way merge fails.

File scope: packages/core/src/task-thread.ts, apps/mcp-server/src/tools/plan.ts

### Sub-task 2: Reject task_ready_for_agent without follow-up task_plan_claim_subtask

When task_ready_for_agent returns claimable subtasks for a session and that session does NOT call task_plan_claim_subtask within a session window (or before the next task_ready_for_agent call), surface a SessionStart hint plus a task_ready_for_agent response field claim_required=true. Loop adoption metric (currently 0/116) should rise above 50% in steady state.

File scope: apps/mcp-server/src/tools/ready-queue.ts, packages/hooks/src/handlers/session-start.ts


## §S  delta
op|target|row
-|-|-

## §T  tasks
id|status|task|cites
-|-|-|-

## §B  bugs
id|status|task|cites
-|-|-|-
