---
'@colony/storage': minor
'@colony/mcp-server': minor
---

Add `account_claims` table and three new MCP tools for binding Codex accounts to planner waves.

`task_claim_account`, `task_release_account_claim`, and `task_list_account_claims` let the recodee planner Account Capacity rail bind a Codex account to a planner wave so multiple operators on the same plan see the same dispatch state. Bindings are keyed by `(plan_slug, wave_id)` — a planner-logical coordinate that exists before any Colony task is spawned — and persist across operators via a new `account_claims` SQLite table. A partial unique index enforces at-most-one-active claim per wave; released claims stay as audit history.

Schema migrates forward-only from version 10 to 11. No data backfill is required: the table starts empty and is populated by user action. The contract is regression-tested via an MCP-inspector test (`apps/mcp-server/test/account-claims.test.ts`) exercising the full claim → rebind → release → list lifecycle.
