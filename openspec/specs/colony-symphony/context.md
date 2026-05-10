# Colony Symphony Context

## Overview

Symphony is the upstream service specification being ported into Colony. The
canonical source is `examples/symphony/SPEC.md` in the recodee monorepo, with
`examples/symphony/README.md` as supporting orientation.

The Elixir reference implementation is read-only for this effort. It can inform
terminology and intent, but Colony adoption work must not vendor, translate, or
depend on the Elixir code.

## Rationale

Colony needs a durable reference point before agents split Symphony adoption
into proposals, requirements, and implementation slices. This context records
the source mapping without making any normative Colony requirements yet.

Symphony's tracker model names Linear because the reference spec targets a
Linear-backed service. For Colony adoption, Linear-as-tracker is N/A: Colony is
the tracker and coordination substrate.

## Scope

This capability context covers the documentation bridge between the Symphony
SPEC and future Colony OpenSpec changes. It is limited to source identity,
porting boundaries, and mapping anchors.

Normative requirements, behavior deltas, and change proposals are intentionally
out of scope here. Agent 202 owns the change proposal that will decide which
Symphony patterns become Colony requirements.

## Mapping Anchors

| Adoption phase | Symphony SPEC anchor |
| --- | --- |
| spec import | Sections 1-3: problem statement, goals/non-goals, and system overview |
| front-matter | Sections 5-6: workflow file contract, front matter schema, and configuration resolution |
| run-attempts | Sections 4.1.5, 10, and 16.5: run attempt model, agent runner protocol, and worker attempt algorithm |
| reconcile | Sections 7-8 and 16.3: orchestration state machine, polling/scheduling, and active-run reconciliation |
| proof gating | Sections 12, 17, and 18: prompt/context assembly, validation matrix, and definition of done |
| observability | Section 13: logging, status, snapshots, and operator-visible observability |
| safety | Sections 9 and 15: workspace management, safety invariants, security, and operational safety |

## Domain Model

This section maps Symphony Section 4 entities to the current Colony task model.
`NEW` marks missing Colony surfaces that later Wave 3-4 agents must land before
run-attempt and reconcile behavior can treat Colony as the single source of
truth.

### Issue

| Symphony field | Colony field/file/MCP tool |
| --- | --- |
| `id` | `tasks.id` in `packages/storage/src/schema.ts` and `TaskRow.id` in `packages/storage/src/types.ts`; exposed as `task_id` by task tools. |
| `identifier` | Existing human/routing identifiers are `tasks.branch`, plan branch `spec/<plan_slug>/sub-<index>`, and live planner display id from `subtask_index + 1`; NEW (Agent 208) durable issue identifier field when imported from an external tracker. |
| `title` | `tasks.title`; plan subtask `metadata.title`; `task_plan_publish.subtasks[].title`; rendered by `apps/frontend/src/features/cave-hivemind/data/colony-live-planner.ts`. |
| `description` | Plan subtask `metadata.description` and `task_plan_publish.subtasks[].description`; task-thread notes via `task_post`; NEW (Agent 208) first-class task description outside plan subtasks. |
| `priority` | `task_ready_for_agent` response `priority` and ranking `fit_score` are computed surfaces, not stored issue priority; NEW (Agent 209). |
| `state` | `tasks.status`; plan subtask lifecycle status `available`, `claimed`, `completed`, or `blocked` in `packages/core/src/plan.ts`; `task_plan_claim_subtask` and `task_plan_complete_subtask`. |
| `branch_name` | `tasks.branch`; Guardex branch/worktree from `gx branch start`; plan branch `spec/<plan_slug>/sub-<index>`. |
| `url` | NEW (Agent 209) external issue URL/link metadata; current task links relate Colony task IDs only. |
| `labels` | NEW (Agent 209) labels/tags on tasks or plan subtasks. |
| `blocked_by` | Plan subtask `depends_on`, `blocked_by`, and `blocked_by_count` in `packages/core/src/plan.ts`; cross-task dependencies/coordination via `task_links` and `task_link`/`task_unlink`. |
| `created_at` | `tasks.created_at`. |
| `updated_at` | `tasks.updated_at`, touched by task-thread writes. |

### Workflow Definition

| Symphony field | Colony field/file/MCP tool |
| --- | --- |
| `config` | `task_plan_publish` input (`problem`, `acceptance_criteria`, `subtasks`, `waves`, `auto_archive`) and queen goal input in `apps/mcp-server/src/tools/queen.ts`; NEW (Agent 210) persisted workflow-front-matter config. |
| `prompt_template` | Live plan subtask prompt builder in `apps/frontend/src/features/cave-hivemind/data/colony-live-planner.ts`; NEW (Agent 210) persisted workflow prompt template separate from generated live-plan prompts. |

### Service Config

| Symphony field | Colony field/file/MCP tool |
| --- | --- |
| poll interval | Attention/ready callers decide polling cadence; NEW (Agent 210) durable orchestrator poll interval. |
| workspace root | `tasks.repo_root`, `sessions.cwd`, `task_plan_publish.repo_root`, and `queen_plan_goal.repo_root`. |
| active and terminal issue states | `tasks.status`; plan subtask lifecycle in `plan-subtask-claim` observations; NEW (Agent 210) configurable active/terminal state sets. |
| concurrency limits | NEW (Agent 211) global and per-workflow concurrency limits. |
| coding-agent executable/args/timeouts | NEW (Agent 211) runner command config. |
| workspace hooks | Guardex/OMX hooks exist outside the Colony task store; NEW (Agent 211) workflow-owned workspace hook config. |

### Workspace

| Symphony field | Colony field/file/MCP tool |
| --- | --- |
| `path` | `sessions.cwd` for live sessions; `tasks.repo_root` for repo scope; quota handoff metadata may carry `worktree_path`; NEW (Agent 211) durable workspace path on task/run attempt. |
| `workspace_key` | Current routing key is `tasks.branch`; plan routing key is `spec/<plan_slug>/sub-<index>`; claim paths normalize to repo-relative paths in `packages/storage/src/claim-path.ts`. |
| `created_now` | NEW (Agent 211) workspace creation bookkeeping for hook gating. |

### Run Attempt

| Symphony field | Colony field/file/MCP tool |
| --- | --- |
| `issue_id` | `task_id` / `tasks.id`; for plan work, `task_id` plus `plan_slug` and `subtask_index`. |
| `issue_identifier` | `tasks.branch`, plan `plan_slug` + `subtask_index`, and live planner display id; NEW (Agent 208) imported issue identifier parity. |
| `attempt` | NEW (Agent 212) durable run-attempt ordinal. |
| `workspace_path` | `sessions.cwd` and handoff `quota_context.worktree_path` when present; NEW (Agent 212) run-attempt workspace path. |
| `started_at` | `sessions.started_at`; claim/attempt-like events use `observations.ts`. |
| `status` | `tasks.status`, plan subtask lifecycle status, and active/paused lane state in `lane_states`. |
| `error` | `task_post` kinds `blocker`, `failed_approach`, `blocked_path`, and `conflict_warning`; NEW (Agent 212) structured run-attempt error field. |

### Live Session

| Symphony field | Colony field/file/MCP tool |
| --- | --- |
| `session_id` | `sessions.id`, MCP `session_id`, `task_participants.session_id`, and `observations.session_id`. |
| `thread_id` | NEW (Agent 213) Codex/runner thread id metadata. |
| `turn_id` | NEW (Agent 213) Codex/runner turn id metadata. |
| `codex_app_server_pid` | NEW (Agent 213) runner process metadata; process liveness currently lives outside task rows. |
| `last_codex_event` | NEW (Agent 214) latest runner event type. |
| `last_codex_timestamp` | NEW (Agent 214) latest runner event timestamp. |
| `last_codex_message` | `observations.content` can store summarized messages; NEW (Agent 214) typed latest runner message. |
| `codex_input_tokens` | NEW (Agent 217) coding-agent token counters. |
| `codex_output_tokens` | NEW (Agent 217) coding-agent token counters. |
| `codex_total_tokens` | NEW (Agent 217) coding-agent token counters. |
| `last_reported_input_tokens` | NEW (Agent 217) delta-report bookkeeping. |
| `last_reported_output_tokens` | NEW (Agent 217) delta-report bookkeeping. |
| `last_reported_total_tokens` | NEW (Agent 217) delta-report bookkeeping. |
| `turn_count` | NEW (Agent 214) runner turn count. |

### Retry Entry

| Symphony field | Colony field/file/MCP tool |
| --- | --- |
| `issue_id` | `task_id` / `tasks.id`. |
| `identifier` | `tasks.branch` or plan `plan_slug` + `subtask_index`; NEW (Agent 208) imported issue identifier parity. |
| `attempt` | NEW (Agent 215) retry attempt ordinal. |
| `due_at_ms` | Handoffs/messages/wakes have `expires_at`; NEW (Agent 215) retry due time. |
| `timer_handle` | NEW (Agent 215) runtime retry handle. |
| `error` | `task_post` blocker/failure observations; NEW (Agent 215) structured retry error field. |

### Orchestrator Runtime State

| Symphony field | Colony field/file/MCP tool |
| --- | --- |
| `poll_interval_ms` | NEW (Agent 216) orchestrator poll interval state. |
| `max_concurrent_agents` | NEW (Agent 216) runtime concurrency state. |
| `running` | Active `sessions`, `task_participants`, `lane_states`, and claimed plan subtasks from `task_plan_claim_subtask`. |
| `claimed` | `task_claims` table; `task_claim_file`; plan subtask claim observations. |
| `retry_attempts` | NEW (Agent 215) retry queue/state. |
| `completed` | `tasks.status`; plan subtask `completed` lifecycle via `task_plan_complete_subtask`. |
| `codex_totals` | NEW (Agent 217) aggregate coding-agent token/runtime totals; current `mcp_metrics` covers MCP call receipts only. |
| `codex_rate_limits` | NEW (Agent 217) latest coding-agent rate-limit snapshot. |

### Normalization Rules

| Symphony rule | Colony alignment |
| --- | --- |
| Issue ID is the internal lookup key. | Use `tasks.id` / `task_id` as the Colony-native internal key. For plan work, treat `task_id` as authoritative and `plan_slug` + `subtask_index` as the stable plan-coordinate alias. Do not use titles as IDs. |
| Issue Identifier is human-readable. | Use `tasks.branch` for current routing, and render plan subtasks as `plan_slug#NN` or `spec/<plan_slug>/sub-<index>` when a compact human identifier is needed. NEW (Agent 208) should add/import a separate issue identifier when external issues arrive. |
| Workspace Key is sanitized from `issue.identifier` by replacing characters outside `[A-Za-z0-9._-]` with `_`. | Existing Colony work uses branch slugs and repo-relative claim paths. Imported Symphony workspaces should compute the same sanitized key before creating durable workspace/run-attempt rows. This is separate from `tasks.id`. |
| Normalized Issue State compares lowercased states. | Existing plan lifecycle states are already lower-case literals. Future imported issue states should lowercase before comparing and then map to `tasks.status` or plan subtask lifecycle. |
| Session ID is `<thread_id>-<turn_id>`. | Current Colony accepts caller-provided `sessions.id`. If Symphony runner metadata is adopted, Agent 213 should either store `<thread_id>-<turn_id>` as `sessions.id` or persist `thread_id` and `turn_id` metadata with a generated `session_id` that preserves this composition. |
