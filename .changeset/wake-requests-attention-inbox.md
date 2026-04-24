---
'@colony/core': minor
'@colony/hooks': minor
'@colony/mcp-server': minor
'@imdeadpool/colony': minor
---

Add wake-request primitive and attention inbox for idle/stalled cross-agent nudges.

- `task_wake` / `task_ack_wake` / `task_cancel_wake` MCP tools post lightweight nudges on a task thread — no claim transfer, no baton pass. Targets see the request on their next SessionStart or UserPromptSubmit turn with a copy-paste-ready ack call.
- `attention_inbox` MCP tool + `colony inbox` CLI command aggregate pending handoffs, pending wakes, stalled lanes from the hivemind snapshot, and recent other-session file claims into one compact view. Bodies are not expanded; fetch via `get_observations`.
- Hook injection extended: `buildTaskPreface` surfaces pending wake requests alongside pending handoffs; `buildTaskUpdatesPreface` inlines an ack call for wake requests that arrive between turns.

Deferred follow-ups (not in this change): safe session takeover, claim TTL renewal, session Stop checkpoint, and any terminal-control wake mechanism.
