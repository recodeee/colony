## ADDED Requirements

### Requirement: Expired Quota Sweep Audit Summary
When coordination sweep releases expired or aged quota-pending claims, the system SHALL include compact audit summary metadata for the release.

#### Scenario: Released quota claims include compact summary
- **GIVEN** coordination sweep releases one or more quota-pending claims
- **WHEN** the sweep result is returned
- **THEN** `released_quota_pending_summary.released_count` equals the number of released quota-pending claims
- **AND** `released_quota_pending_summary.oldest_age_minutes` reports the oldest released claim age
- **AND** `released_quota_pending_summary.top_tasks` reports affected tasks with released count and oldest age
- **AND** human `colony coordination sweep` output includes the same compact quota release summary.
