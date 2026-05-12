## ADDED Requirements

### Requirement: SessionStart contract preface mode is configurable

The `@colony/config` Settings schema SHALL expose `sessionStart.contractMode` accepting exactly `'compact'`, `'full'`, or `'none'`, defaulting to `'compact'`.

#### Scenario: Default install emits the compact contract pointer

- **GIVEN** a fresh install with no user override of `sessionStart.contractMode`
- **WHEN** the SessionStart hook fires in a detected git repo
- **THEN** the preface contains a single-line pointer to `AGENTS.md` that names `hivemind_context`, `attention_inbox`, and `task_ready_for_agent`
- **AND** the preface does NOT contain the verbose `Shutdown / finish contract` or `Before quota/session stop` paragraphs.

#### Scenario: Opt-in full mode restores the legacy contract

- **GIVEN** `sessionStart.contractMode` is set to `'full'`
- **WHEN** the SessionStart hook fires in a detected git repo
- **THEN** the preface contains the historical `## Quota-safe Colony operating contract` block verbatim, including the RTK policy, the work/during-work/shutdown paragraphs, and the quota-exit paragraph.

#### Scenario: Disabled mode suppresses the contract entirely

- **GIVEN** `sessionStart.contractMode` is set to `'none'`
- **WHEN** the SessionStart hook fires
- **THEN** the preface omits the operating-contract section entirely
- **AND** other prefaces (task thread, foraging, ready-claim nudge, attention budget) are unaffected.

#### Scenario: Non-repo cwd still suppresses every contract mode

- **GIVEN** any `sessionStart.contractMode` value
- **WHEN** the SessionStart hook fires outside a git repo (no `detectRepoBranch` result)
- **THEN** the preface omits the operating-contract section.
