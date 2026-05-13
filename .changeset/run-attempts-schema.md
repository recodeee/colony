---
"@colony/storage": minor
---

Add `task_run_attempts` table + repository helpers (Symphony §4.1.5 / §7.2 — run-attempt lifecycle). New exports: `createRunAttempt`, `getRunAttempt`, `listRunAttemptsByTask`, `updateRunAttemptStatus`, `recordRunAttemptEvent`, `finishRunAttempt`, `RunAttemptError`, plus types `TaskRunAttemptRow`, `NewTaskRunAttempt`, `TaskRunAttemptEventUpdate`, `TaskRunAttemptFinish`, `RunAttemptStatus`, `RunAttemptTerminalStatus` and constants `RUN_ATTEMPT_ACTIVE_STATUSES` / `RUN_ATTEMPT_TERMINAL_STATUSES`. Foundation for Symphony Wave 3 MCP tools (Agents 209/210/211).
