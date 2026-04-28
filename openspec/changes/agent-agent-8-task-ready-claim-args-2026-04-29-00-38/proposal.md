# Task Ready Claim Args

## Why

`task_ready_for_agent` can return an empty ready list without saying whether
the agent should claim a plan subtask, publish a plan, or browse task threads.
That makes the startup loop noisy when no plan subtasks exist.

## What Changes

- Add explicit `task_plan_claim_subtask` routing fields when claimable plan
  subtasks exist.
- Add a compact no-work empty state when no claimable plan subtasks exist.
- Document the ready queue response contract.

## Impact

Agents can either claim the exact subtask returned by `task_ready_for_agent` or
see why there is nothing to claim without fabricating work.
