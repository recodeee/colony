---
'@colony/core': patch
---

Add 4 reference rows to `SAVINGS_REFERENCE_ROWS` so `colony gain` can match operations that were previously bucketed as unmatched: **Plan publication & goal anchoring** (`queen_plan_goal`, `task_plan_publish`, `task_plan_validate`, `task_propose`), **Task thread note** (`task_post`, `task_reinforce`), **Task dependency linking** (`task_link`, `task_links`, `task_unlink`), and **Agent profile sync** (`agent_get_profile`, `agent_upsert_profile`). The "Live matched total" and "Top saving" lines in the gain report now reflect savings on these surfaces instead of leaving the calls in the unmatched footer.
