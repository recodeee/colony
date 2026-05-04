---
'@colony/mcp-server': minor
'@colony/core': patch
---

Add `task_autopilot_tick` and `task_drift_check` MCP tools — light-weight ports of two ideas from the Ruflo autopilot/swarm playbook, mapped onto Colony primitives.

`task_autopilot_tick` is a one-shot advisor that combines `attention_inbox` + `task_ready_for_agent` into a single decision (next tool + args + sleep hint). The loop itself stays caller-side (Claude Code's `ScheduleWakeup`, the `/loop` skill, or cron) — this MCP call is stateless. Decision priority: pending handoff → quota relay → blocking message → claim ready subtask → continue current claim → no-op. Stalled lanes whose only signal is "Session start"/"No active swarm" are classified as dead heartbeats and excluded from the actionable count, so callers don't escalate on noise.

`task_drift_check` compares a session's claims for a given task against its recent edit-tool observations within a configurable window. Surfaces files edited without a matching claim (drift) and claims with no recent edit activity (potentially abandoned). File-scope drift only — does not analyze semantic drift from the task description.

Both tools are pure compositions of existing storage and core helpers; no SQL migration, no new package, no edits to `packages/storage/src/storage.ts`. `@colony/core` re-exports `InboxQuotaPendingClaim` so downstream tools can build typed quota-relay payloads.
