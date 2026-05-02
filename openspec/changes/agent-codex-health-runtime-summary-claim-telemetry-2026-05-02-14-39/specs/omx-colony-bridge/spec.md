## MODIFIED Requirements

### Requirement: Health Joins Runtime Lifecycle Claim Telemetry

`colony health` SHALL include fresh OMX runtime summary lifecycle event evidence in claim-before-edit telemetry when the summary records ordered `pre_tool_use` and `post_tool_use` edit events for the same file path.

#### Scenario: Fresh runtime summary contains ordered edit lifecycle events

- **WHEN** the runtime summary bridge is `available`
- **AND** the fresh summary includes a `pre_tool_use` edit event before the matching `post_tool_use` edit event
- **AND** storage-backed claim-before-edit rows are absent for the same window
- **THEN** `task_claim_file_before_edits.hook_capable_edits` is greater than `0`
- **AND** `task_claim_file_before_edits.pre_tool_use_signals` is greater than `0`
- **AND** `task_claim_file_before_edits.measurable_edits` is greater than `0`
- **AND** health SHALL NOT report lifecycle bridge missing or silent as the claim-before-edit root cause.

#### Scenario: Fresh runtime summary has edit paths without lifecycle event order

- **WHEN** the runtime summary bridge is `available`
- **AND** `recent_edit_paths` is populated
- **AND** no ordered `pre_tool_use` before `post_tool_use` lifecycle evidence is present
- **AND** storage-backed claim-before-edit rows are absent
- **THEN** health SHALL NOT count those plain paths as successful claim-before-edit telemetry
- **AND** the root cause kind SHALL be `lifecycle_summary_not_joined`.
