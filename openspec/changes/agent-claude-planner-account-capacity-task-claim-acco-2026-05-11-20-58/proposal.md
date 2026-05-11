## Why

The recodee planner page (`/colony-hivemind/planner`) wants to bind a Codex account to a planner wave so multiple operators on the same plan see the same dispatch state. Today the planner has no shared concept of "which account this wave is going to use" — that decision lives implicitly in whichever account happens to be live when an agent spawns. The recodee Account Capacity rail feature (separate PR in `recodeee/recodee`) needs a first-class Colony surface to read and write those bindings; without it, the rail would need an OMX-style sidecar that contradicts the project's Colony-first coordination contract.

## What Changes

- New `account_claims` SQLite table keyed by `(plan_slug, wave_id)`. Lifecycle is intentionally simpler than `task_claims`: only `active` and `released` states, no handoff baton. A partial unique index enforces at-most-one-active claim per wave.
- Three new MCP tools registered in `apps/mcp-server`:
  - `task_claim_account` — bind an account to a wave. If the same `(plan_slug, wave_id, account_id, session_id)` is rebound the row is refreshed in place; otherwise the prior active row is released and a new one is inserted, both in the same transaction.
  - `task_release_account_claim` — flip an active claim to `released` and stamp `released_at` + `released_by_session_id`. Audit-preserving.
  - `task_list_account_claims` — list claims with optional `plan_slug`, `account_id`, `state` filters (default returns both `active` and `released`).
- Storage layer methods added on `Storage`: `claimAccount`, `releaseAccountClaim`, `getActiveAccountClaim`, `getAccountClaimById`, `listAccountClaims`, plus a private `normalizeAccountClaimRow`.
- `@colony/storage` re-exports `AccountClaimRow`, `AccountClaimState`, `NewAccountClaim`.
- Schema version bumped from `10` to `11`. No data backfill — the new table starts empty.
- New regression test file `apps/mcp-server/test/account-claims.test.ts` covering the create → rebind → release → list lifecycle and the partial-unique-index invariant.
- `docs/mcp.md` adds a new "Account claims" row to the tool index and three new sections with worked JSON examples.
- Changeset entry as minor bump for `@colony/storage` + `@colony/mcp-server`.

## Impact

- **Schema migration**: forward-only via `CREATE TABLE IF NOT EXISTS` in `SCHEMA_SQL`; no `COLUMN_MIGRATIONS` entry is needed because the table is brand new. Schema version 10 → 11.
- **No change** to existing task_claims, task_post, task_message, or any other live tool. The new tools are purely additive.
- **MCP inspector tool-list snapshot** (`server.test.ts`) extended with the three new alphabetical entries.
- **Performance**: the partial unique index makes the active-claim lookup O(log n) on `(plan_slug, wave_id)`, and listing is bounded by `limit` (default 200, max 500).
- **Downstream**: the recodee planner PR cannot wire its rail to these tools until this PR is merged and the colony CLI is rebuilt/republished. The recodee PR description references this PR's URL + merge state for traceability.
