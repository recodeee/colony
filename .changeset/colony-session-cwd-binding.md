---
"@colony/hooks": patch
"@colony/storage": patch
"colony": patch
---

Bind hook-created sessions back to their repository cwd so colony views can see live Codex/Claude work instead of orphan `cwd: null` sessions.
