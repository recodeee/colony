## Why

Stale Queen plan subtasks can stay marked `claimed` after the owning session is gone.
When that claimed subtask is an upstream dependency, `task_ready_for_agent`
correctly reports no ready work but the MCP rescue path only reports skipped
dead sessions, so the plan remains blocked.

## What Changes

- Route MCP stranded rescue through the bulk stranded cleanup path so dead
  sessions with held claims are actionable from MCP.
- When bulk rescue releases a stranded owner's claims for a claimed plan
  subtask, append an `available` lifecycle marker so the subtask returns to the
  ready queue.
- Record audit metadata listing the requeued plan subtasks.

## Impact

- Affects `rescue_stranded_scan` / `rescue_stranded_run`, bulk stranded rescue,
  and Queen plan readiness after stale owner cleanup.
- Completed subtasks remain terminal; only subtasks still claimed by the
  stranded session are requeued.
- Focused tests cover core rescue requeueing, MCP rescue release behavior, and
  the existing ready-queue stale blocker path.
