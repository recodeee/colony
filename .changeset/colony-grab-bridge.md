---
'colonyq': minor
---

Add `colony grab` command group: a per-project localhost intake daemon that
turns a react-grab "Add context" submit into a colony task on a fresh
`agent/*` worktree and starts a detached `tmux` session running `codex`
inside it.

- `colony grab serve` — long-lived HTTP daemon on 127.0.0.1 with strict
  request gating (bearer token, `Origin` allowlist, JSON content-type,
  CORS preflight). On accepted `POST /grab`, creates a colony task,
  posts the react-grab payload as a `kind: "note"` observation, writes
  `.colony/INTAKE.md` into the worktree, and spawns `tmux new-session -d`
  running `codex` in the worktree.
- `colony grab attach <task-id>` — convenience attach to the spawned
  tmux session `rg-<task-id>`.
- `colony grab status` — list grab daemons known to `$COLONY_HOME`.

In-memory dedup (default 5 min window) keyed by
`sha256(repo_root|file_path|content|extra_prompt)` collapses repeat
submits into `task_post` notes on the existing task.

The daemon is off by default; it must be started explicitly.
