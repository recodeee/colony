## ADDED Requirements

### Requirement: Active Claims Renew On Owner Activity

Colony SHALL extend a file claim's lease deadline whenever the owning session
performs a coordination call that names the same `(task_id, file_path)`. A
claim SHALL NOT expire while its owner is actively coordinating on it.

#### Scenario: owner re-claims its own file

- **WHEN** the session that owns an `active` claim on `(task_id, file_path)`
  calls `task_claim_file` again for the same `(task_id, file_path)`
- **THEN** Colony advances `expires_at` to `now + claimLeaseDurationMinutes`
- **AND** the claim's `state` stays `active`
- **AND** the response includes `lease_expires_at` and `lease_last_renewed_at`

#### Scenario: owner posts a working note naming the file

- **WHEN** the owning session calls `task_note_working` whose `file_path` set
  contains a path that matches an `active` claim it owns
- **THEN** Colony advances that claim's `expires_at` to
  `now + claimLeaseDurationMinutes`
- **AND** no new tool call or heartbeat is required

#### Scenario: owner records an observation against the file

- **WHEN** the owning session creates a `task_post` observation whose
  `file_path` matches an `active` claim it owns
- **THEN** Colony advances that claim's `expires_at` to
  `now + claimLeaseDurationMinutes`

#### Scenario: non-owner activity does not renew

- **WHEN** any session that does not own the claim posts a working note,
  observation, or re-claim attempt for `(task_id, file_path)`
- **THEN** the claim's `expires_at` is unchanged
- **AND** `task_claim_file` from the non-owning session continues to follow
  the existing single-owner-per-file rejection path

#### Scenario: lapsed lease is collected by sweep

- **WHEN** an `active` claim's `expires_at` is in the past and no renewal call
  has arrived during the lease window
- **THEN** the existing coordination sweep transitions the claim from
  `active` to `weak_expired` through its current path
- **AND** the sweep MUST NOT downgrade a claim whose `expires_at` is still in
  the future, even if the surrounding session looks idle

### Requirement: Lease Duration Is Configurable

Colony SHALL expose lease duration as a setting so repos can tune it for the
expected length of a coordinated edit.

#### Scenario: default lease duration applies

- **WHEN** a session opens a new claim and `claimLeaseDurationMinutes` is set
  to its default of `30`
- **THEN** `expires_at` is set to `claimed_at + 30 minutes`
- **AND** subsequent owner-side coordination calls renew it by the same
  duration

#### Scenario: lease duration is documented through settings docs

- **WHEN** a user runs `colony config show` or invokes `settingsDocs()`
- **THEN** the output includes `claimLeaseDurationMinutes` with its
  description and default value
- **AND** no parallel documentation source is required

### Requirement: Null Lease Migration Is One-Shot And Forward

Colony SHALL repair pre-lease claim rows the first time their owner renews,
without retroactively expiring or reviving claims.

#### Scenario: legacy claim renews for the first time

- **WHEN** the owning session triggers a renewal source against an `active`
  claim whose `expires_at` is `NULL`
- **THEN** Colony sets `expires_at = now + claimLeaseDurationMinutes`
- **AND** Colony does not set `expires_at` to any time in the past
- **AND** the migration is recorded as a normal renewal, not as a separate
  observation kind
