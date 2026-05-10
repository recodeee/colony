# Colony Symphony Import Requirements

## ADDED Requirements

### Requirement: Wave 1 Foundation Ledger

Colony SHALL maintain a docs-only foundation wave before implementation begins.

#### Scenario: foundation artifacts are claimed

- **GIVEN** Agents 200-202 are preparing Symphony adoption inputs
- **WHEN** the umbrella change is opened
- **THEN** the context, domain mapping, proposal, design, spec, and tasks ledger are present
- **AND** no upstream Symphony Elixir implementation is vendored, translated, or copied into Colony
- **AND** Linear-specific tracker behavior is documented as N/A for Colony adoption

### Requirement: Wave 2 Workflow Contract

Colony SHALL implement Symphony Section 18.1 workflow contract items as REQUIRED
for conformance when this wave enters implementation.

#### Scenario: workflow contract is loaded

- **GIVEN** a Colony runtime starts from a repository workspace
- **WHEN** workflow configuration is resolved
- **THEN** explicit runtime path selection and cwd default selection are REQUIRED
- **AND** `WORKFLOW.md` loading with YAML front matter plus prompt body split is REQUIRED
- **AND** typed config defaults and `$` environment indirection are REQUIRED
- **AND** dynamic `WORKFLOW.md` watch/reload/re-apply for config and prompt is REQUIRED

### Requirement: Wave 3 Colony Tracker Intake

Colony SHALL treat Colony task state as the tracker source for Symphony adoption.

#### Scenario: tracker intake reads Colony state

- **GIVEN** Colony is the tracker and coordination substrate
- **WHEN** candidate work is fetched for dispatch or reconciliation
- **THEN** candidate fetch, state refresh, and terminal fetch are REQUIRED
- **AND** tracker payload normalization into stable issue/task models is REQUIRED
- **AND** Linear GraphQL behavior from Symphony Section 18.2 is RECOMMENDED only when a future
  extension intentionally targets Linear interoperability
- **AND** pluggable tracker adapters from Symphony Section 18.2 are RECOMMENDED, not REQUIRED

### Requirement: Wave 4 Workspace And Agent Attempts

Colony SHALL port the Symphony worker-attempt contract around isolated
workspaces, hooks, app-server launch, prompts, and retries.

#### Scenario: worker attempt starts

- **GIVEN** a claimable Colony task is selected for execution
- **WHEN** a worker attempt is prepared
- **THEN** sanitized per-issue or per-task workspaces are REQUIRED
- **AND** workspace lifecycle hooks `after_create`, `before_run`, `after_run`, and
  `before_remove` are REQUIRED
- **AND** hook timeout config with default `60000` ms is REQUIRED
- **AND** coding-agent app-server subprocess client JSON line protocol is REQUIRED
- **AND** configurable Codex launch command with default `codex app-server` is REQUIRED
- **AND** strict prompt rendering with `issue` and `attempt` variables is REQUIRED
- **AND** exponential retry queue with continuation retries after normal exit is REQUIRED
- **AND** retry backoff cap with default five minutes is REQUIRED
- **AND** persisting retry queue and session metadata across process restarts is RECOMMENDED

### Requirement: Wave 5 Reconciliation And Status Safety

Colony SHALL keep one orchestration authority for polling, reconciliation, and
terminal cleanup without accidental task status flips.

#### Scenario: reconciliation sees inactive or terminal task state

- **GIVEN** a task or run is no longer active
- **WHEN** reconciliation observes the state change
- **THEN** polling orchestration with single-authority mutable state is REQUIRED
- **AND** claimed and running checks before launch are REQUIRED
- **AND** reconciliation that stops runs on terminal or non-active tracker states is REQUIRED
- **AND** workspace cleanup for terminal issues via startup sweep and active transition is REQUIRED
- **AND** status changes MUST NOT be written unless a later change explicitly defines and verifies
  the Colony write contract

### Requirement: Wave 6 Observability And Optional Control Surface

Colony SHALL expose operator-visible observability for Symphony adoption.

#### Scenario: operator inspects runtime behavior

- **GIVEN** one or more Colony worker attempts have run
- **WHEN** runtime evidence is inspected
- **THEN** structured logs with `issue_id`, `issue_identifier`, and `session_id` are REQUIRED
- **AND** operator-visible observability through structured logs is REQUIRED
- **AND** runtime snapshot or status surfaces are RECOMMENDED when shipped
- **AND** HTTP server behavior from Symphony Section 18.2 is RECOMMENDED only if Colony ships that
  extension, including CLI `--port` precedence, safe default bind host, and baseline endpoints
- **AND** observability settings in workflow front matter are RECOMMENDED without prescribing UI
  implementation details

### Requirement: Wave 7 Safety And Production Validation

Colony SHALL close Symphony adoption with safety validation and extension
boundary checks before archival.

#### Scenario: adoption is ready to archive

- **GIVEN** Waves 1-6 have completed with evidence
- **WHEN** the umbrella change is prepared for archival
- **THEN** production validation against the target host OS and shell environment is RECOMMENDED
- **AND** hook execution and workflow path resolution validation are RECOMMENDED
- **AND** optional HTTP server bind and port behavior validation is RECOMMENDED if shipped
- **AND** first-class tracker write APIs are RECOMMENDED only as a future explicit extension
- **AND** no checklist item is complete without tests, validation output, PR evidence, or documented
  blocker evidence
