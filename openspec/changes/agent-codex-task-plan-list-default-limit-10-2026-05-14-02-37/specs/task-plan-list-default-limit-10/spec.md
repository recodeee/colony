## ADDED Requirements

### Requirement: Compact task_plan_list default
The system SHALL default `task_plan_list` and core `listPlans()` responses to at most 10 plans when callers omit an explicit limit.

#### Scenario: Default list is compact
- **WHEN** more than 10 published plans exist
- **AND** a caller invokes `task_plan_list` without `limit`
- **THEN** the response contains at most 10 plans.

#### Scenario: Explicit larger limit remains available
- **WHEN** more than 10 published plans exist
- **AND** a caller invokes `task_plan_list` with an explicit limit above 10 and within the existing cap
- **THEN** the response honors the explicit limit.
