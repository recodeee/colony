---
'@colony/storage': minor
'@colony/core': minor
'@colony/hooks': minor
---

Add pheromone trails: ambient decaying activity signal per (task, file, session). `PostToolUse` deposits pheromone on every write-tool invocation; strength decays exponentially (10-minute half-life, cap 10.0). The new `UserPromptSubmit` preface warns when another session has a strong trail on a file the current session has also touched, complementing the existing claim-based preface with a graded intensity signal that doesn't fire for stale collisions. Schema bumped to version 4 — adds `pheromones` table with FK cascade on sessions and tasks.
