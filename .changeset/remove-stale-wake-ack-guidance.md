---
"@colony/cli": patch
"@colony/hooks": patch
"@colony/storage": patch
---

Remove stale `task_ack_wake` guidance from docs, CLI inbox output, hook prefaces, and tool classification now that wake MCP tools are no longer exposed. Pending wake observations still surface for visibility, but agents are routed to `task_message` / `task_post` instead of the deleted ack tool.
