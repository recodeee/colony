---
"@imdeadpool/colony-cli": patch
---

Drop the drifted local copy of `inferIdeFromSessionId` in the hook command and import the shared helper from `@colony/core`. The local copy only matched `codex@` / `claude@` prefixes, so ids like `agent/claude/<task>`, `codex-<task>`, or `claudecode/foo` fell through as `undefined` and the hook wrote `ide = 'unknown'` for them — the same drift the `colony backfill ide` command then had to repair. One source of truth means the write path and the backfill path cannot diverge again.
