---
"@colony/hooks": patch
"@colony/foraging": patch
---

Surface silent `catch {}` failures to stderr (rule #9).

Every empty catch in `session-start`, `scanner`, and the foraging MCP tool now either logs a `[colony] <site>: <message>` line to stderr or carries a one-line comment explaining why silence is intentional (fs-stat races, missing-directory guards, best-effort cleanup). Previously a whole session's 43/43 MCP call failures could vanish with no trace.
