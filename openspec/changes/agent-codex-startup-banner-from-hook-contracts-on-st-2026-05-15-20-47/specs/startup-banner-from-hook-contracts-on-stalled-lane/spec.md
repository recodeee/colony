## ADDED Requirements

### Requirement: startup-banner-from-hook-contracts-on-stalled-lane behavior
The OMX lifecycle SessionStart route SHALL preserve stalled-lane attention
signals that exist before the SessionStart hook refreshes active-session
telemetry.

#### Scenario: Lifecycle SessionStart resumes a stale lane
- **GIVEN** the repo has a stale or dead active-session lane before lifecycle routing
- **WHEN** an OMX `session_start` envelope is routed for that repo
- **THEN** the returned SessionStart context includes a bounded stalled-lane banner
- **AND** the banner is collected before the SessionStart hook refreshes telemetry.

#### Scenario: Stalled lane attention is noisy
- **GIVEN** more stalled lanes exist than the startup banner can show
- **WHEN** lifecycle SessionStart renders the startup context
- **THEN** the banner shows at most three stalled lanes
- **AND** collapsed lanes are summarized with an `attention_inbox` follow-up hint.
