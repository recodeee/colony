# Tasks

| # | Status | Title | Files | Depends on | Capability | Spec row | Owner |
| - | - | - | - | - | - | - | - |
0|available|Sweep expired quota-pending claims via coordination_sweep|`packages/core/src/coordination-sweep.ts`<br>`packages/core/src/scoped-claim.ts`<br>`apps/cli/src/commands/coordination.ts`|-|infra_work|-|-
1|available|Auto-archive completed Queen plans when remaining_subtasks=0|`packages/core/src/task-thread.ts`<br>`apps/mcp-server/src/tools/plan.ts`|-|api_work|-|-
2|available|Reject task_ready_for_agent without follow-up task_plan_claim_subtask|`apps/mcp-server/src/tools/ready-queue.ts`<br>`packages/hooks/src/handlers/session-start.ts`|-|api_work|-|-
