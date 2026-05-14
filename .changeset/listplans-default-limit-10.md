---
'@colony/core': patch
---

Drop the default `listPlans` limit from 50 → 10.

Companion to the compact-default `task_plan_list` from #531. Even with compact responses, callers that don't pass `limit` were getting 50 plans by default. Lowering the implicit default trims the long tail for `task_plan_list` callers that omit `limit` — the explicit `.max(50)` ceiling on the MCP schema is preserved for callers that want more. Verified post-#531 that `colony gain` shows the predicted ~87% reduction on per-call token cost when the new binary is live; this change squeezes the remaining ~10-15% for non-compact-aware callers.
