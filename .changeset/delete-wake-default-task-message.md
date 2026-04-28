---
"@colony/mcp-server": minor
---

Remove the unused wake MCP tools from the live server surface and make `task_message` match `task_post` ergonomics: callers can now send a broadcast with only `task_id`, `session_id`, `agent`, and `content`, while directed-message knobs remain optional.
