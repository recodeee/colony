---
"@colony/hooks": patch
"@imdeadpool/colony-cli": patch
---

Trim the session-start "Joined with" line and the per-turn conflict
preface so they stop scaling with all-time-joined participants and full
agent-worktree paths. Long-running task threads were spending hundreds
of tokens on stale session lists every resume; the conflict preface was
spending hundreds more per turn on duplicated worktree prefixes. Cap
joined-with at 8 entries with `+N more` overflow, gate by a 1-hour
last-activity window, and strip `.omx|.omc/agent-worktrees/<dir>/`
from claimed file paths plus collapse session ids to their 8-char
shorthand.
