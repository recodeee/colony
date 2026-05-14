---
'@colony/mcp-server': minor
'colonyq': minor
'@colony/core': patch
---

Surface unpublished on-disk plan workspaces in `task_plan_list`, and chain `plan create` into `plan publish`

Two related improvements so orchestrators (and fleets of codex workers) don't waste cap on a plan they have a workspace for but never registered in Colony:

- `task_plan_list` now scans `openspec/plans/*` and merges any disk workspace whose slug is not already registered, marked `registry_status: 'unpublished'`. Workers cannot claim from these, but seeing them lets the orchestrator notice and run `colony plan publish <slug>`. Pass `include_unpublished: false` to mirror the legacy registered-only behavior.
- `colony plan create` now accepts `--publish` (plus optional `--publish-session`, `--publish-agent`, `--publish-auto-archive`) which chains into the same publish path immediately after the workspace is created, eliminating the "I created a plan but workers don't see it" failure mode.
- `PlanInfo.registry_status` gains an `'unpublished'` variant.
