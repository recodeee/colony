# Tasks

- [x] Inspect existing `hivemind_context`, `attention_inbox`, `task_ready_for_agent`, `task_note_working`, and health surfaces.
- [x] Add compact startup panel MCP tool that composes existing data.
- [x] Include session/repo/branch, active task, ready task, inbox, claims, blocker, next, evidence, warnings, and exact next tool args.
- [x] Add coverage for no active task, active blocker, ready Queen subtask, directed inbox message, stale warning, and quota warning.
- [x] Run focused MCP/server tests.
- [x] Run OpenSpec validation.
- [x] Finish through PR merge and sandbox cleanup. Evidence: PR https://github.com/recodeee/colony/pull/348 `MERGED` at 2026-05-01T17:50:50Z with merge commit `9bcb32cdf31a3dc36cea56335c65849162bed26f`; no `agent/agent1/colony-startup-panel-2026-05-01-19-40` branch/worktree remains in `git branch --all --list "*colony-startup-panel*"` or `git worktree list --porcelain`.
