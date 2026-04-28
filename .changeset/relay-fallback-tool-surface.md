---
"@colony/mcp-server": patch
"@imdeadpool/colony-cli": patch
---

Document the task relay fallback on the MCP tools that remain visible when a
client does not expose `task_relay`. `task_post` now tells agents what relay
context to record, `task_hand_off` explains how to resume from a base branch
instead of a missing source lane, and `colony debrief` names `task_relay` as a
coordination commit example.
