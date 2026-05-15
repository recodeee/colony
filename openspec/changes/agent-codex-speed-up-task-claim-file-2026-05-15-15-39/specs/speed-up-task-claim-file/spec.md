## ADDED Requirements

### Requirement: task_claim_file avoids live-contention scans on successful claims
The `task_claim_file` MCP handler SHALL avoid the repo-wide live file
contention scan when `guardedClaimFile` returns a successful claim status. For
successful claims it SHALL preserve the response shape with `warning: null` and
`live_file_contentions: []`. The guarded claim decision SHALL remain responsible
for hard failures such as active owners, protected branch rejection, invalid
paths, and takeover recommendations.

#### Scenario: Uncontended claim returns compact success
- **GIVEN** a task has no competing scoped claim for `file_path=F`
- **WHEN** `task_claim_file` is called for `F`
- **THEN** the claim succeeds
- **AND** the response contains `warning: null`
- **AND** the response contains `live_file_contentions: []`

#### Scenario: Active owner still blocks
- **GIVEN** another active session owns a scoped claim for `file_path=F`
- **WHEN** `task_claim_file` is called for `F`
- **THEN** the handler returns `CLAIM_HELD_BY_ACTIVE_OWNER`
- **AND** no successful claim is recorded for the requester
