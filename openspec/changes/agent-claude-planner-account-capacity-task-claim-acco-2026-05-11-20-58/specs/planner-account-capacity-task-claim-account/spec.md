## ADDED Requirements

### Requirement: account_claims table backs planner-side account bindings

The colony storage layer SHALL persist account-to-wave bindings in a dedicated `account_claims` SQLite table keyed by `(plan_slug, wave_id)`. The table SHALL include columns for `id` (PK), `plan_slug`, `wave_id`, `account_id`, `session_id` (nullable, FK to `sessions` with `ON DELETE SET NULL`), `agent`, `claimed_at`, `state` (`active` | `released`), `expires_at`, `released_at`, `released_by_session_id`, and `note`. A partial unique index SHALL enforce at most one `state = 'active'` row per `(plan_slug, wave_id)`.

#### Scenario: Schema version is bumped to 11
- **WHEN** a fresh colony database is created from the current `SCHEMA_SQL`
- **THEN** `SELECT version FROM schema_version` returns `11`.

#### Scenario: Partial unique index prevents two active claims per wave
- **WHEN** an `INSERT INTO account_claims(plan_slug, wave_id, account_id, state)` is attempted while another row with the same `(plan_slug, wave_id)` already has `state = 'active'`
- **THEN** the storage layer SHALL either refresh the existing row in place (same `(plan_slug, wave_id, account_id, session_id)`) or release the prior active row before inserting the new one — never produce two simultaneous `state = 'active'` rows for the same wave.

### Requirement: task_claim_account MCP tool

The colony MCP server SHALL expose a `task_claim_account` tool that takes `plan_slug`, `wave_id`, `account_id`, and optional `session_id`, `agent`, `expires_at`, `note`. The tool SHALL return `{ claim }` containing the active row written.

#### Scenario: First claim on a wave inserts a new active row
- **WHEN** `task_claim_account` is called for `(plan_slug, wave_id)` with no prior active row
- **THEN** the response `claim` SHALL have `state === 'active'`, `released_at === null`, a numeric `id`, and a numeric `claimed_at`.

#### Scenario: Rebinding the same account on the same wave refreshes the row in place
- **WHEN** `task_claim_account` is called twice in a row with identical `(plan_slug, wave_id, account_id, session_id)`
- **THEN** both responses SHALL share the same `claim.id`, the `claimed_at` and `note` SHALL be updated to reflect the second call, and there SHALL be exactly one row in `account_claims` for that wave.

#### Scenario: Rebinding to a different account releases the prior binding
- **WHEN** `task_claim_account` is called for `(plan_slug, wave_id, account_id=A)` and then `(plan_slug, wave_id, account_id=B)`
- **THEN** the prior row for `A` SHALL have `state === 'released'` and `released_at !== null`, the new row for `B` SHALL have `state === 'active'`, and `task_list_account_claims({ plan_slug })` SHALL return exactly two rows.

### Requirement: task_release_account_claim MCP tool

The colony MCP server SHALL expose a `task_release_account_claim` tool that takes a numeric `id` and optional `released_by_session_id`. The tool SHALL flip an `active` row to `released`, stamp `released_at` and `released_by_session_id`, and return `{ released, claim }`. When the id does not match any row the tool SHALL return `{ released: false, id }`.

#### Scenario: Releasing an active claim frees the wave's active slot
- **WHEN** an active claim is released and a new `task_claim_account` is then called for the same `(plan_slug, wave_id)` and same `account_id`
- **THEN** the new call SHALL succeed and return a `claim` with a new `id` (different from the released row's `id`) and `state === 'active'`.

#### Scenario: Releasing a missing id returns released:false
- **WHEN** `task_release_account_claim` is called with an `id` that does not exist
- **THEN** the response SHALL be `{ released: false, id: <input id> }` without throwing.

### Requirement: task_list_account_claims MCP tool

The colony MCP server SHALL expose a `task_list_account_claims` tool that takes optional `plan_slug`, `account_id`, `state`, and `limit` filters and returns `{ claims }` ordered by `claimed_at DESC`. The default `limit` SHALL be `200` and the maximum `500`. Omitting `state` SHALL include both `active` and `released` rows.

#### Scenario: Filter by state returns only matching rows
- **WHEN** `task_list_account_claims({ plan_slug, state: 'active' })` is called
- **THEN** every returned row SHALL have `state === 'active'` and `released_at === null`.

#### Scenario: Empty result for unmatched plan_slug
- **WHEN** `task_list_account_claims({ plan_slug: '<unused>' })` is called
- **THEN** the response SHALL be `{ claims: [] }`.

#### Scenario: Same account active on multiple waves is listed independently
- **WHEN** the same `account_id` is bound to two different waves on the same plan
- **THEN** `task_list_account_claims({ account_id, state: 'active' })` SHALL return two rows whose `wave_id` values are distinct.
