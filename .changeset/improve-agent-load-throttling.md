---
"@colony/config": patch
"@colony/hooks": patch
---

Reduce burst load from many concurrent agents by coalescing SessionStart foraging scans and adding configurable active-session reconciliation throttling for MCP servers.
