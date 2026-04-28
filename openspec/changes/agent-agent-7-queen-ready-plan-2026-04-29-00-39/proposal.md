# Publish claimable adoption-fix plan

## Problem

Colony health can show zero plan subtasks and zero ready-to-claim work even when
multi-agent adoption fixes are known. Queen needs a concrete ordered-wave
fixture, and `task_ready_for_agent` needs a direct claim hint so agents move
from ready work to `task_plan_claim_subtask`.

## Scope

- Add a current adoption-fix ordered-wave fixture.
- Prove the fixture publishes ready Wave 1 subtasks.
- Add `next_action` to `task_ready_for_agent`.
- Document the ready queue response shape and Queen wave example.

## Acceptance

- Publishing the adoption-fix plan yields nonzero `ready` and `total_available`.
- The ready queue response tells agents to call `task_plan_claim_subtask`.
- Queen remains publish-only and does not launch agents.
