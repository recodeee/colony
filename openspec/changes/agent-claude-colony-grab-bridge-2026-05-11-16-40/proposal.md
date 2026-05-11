## Why

A developer running a Vite/Next dev server with `react-grab` loaded selects a
UI element, types a fix note in the "Add context" textarea, and presses the
submit arrow. Today that action only writes a structured prompt to the system
clipboard. The natural next step — handing the prompt to a coding agent that
already coordinates through colony — requires the user to alt-tab to a
terminal, open a worktree, paste, and prompt the agent by hand.

Colony already coordinates agents via `task_*` MCP tools and tracks tasks per
`(repo_root, branch)`. The missing piece is a localhost intake that turns a
react-grab submit into a colony task on a fresh `agent/*` branch and starts a
codex session in a tmux pane sitting in the matching worktree.

## What Changes

- ADD a new CLI command group `colony grab` with three subcommands:
  - `colony grab serve` — long-lived localhost HTTP daemon that accepts
    react-grab submit payloads and converts each into a colony task plus a
    detached tmux session running `codex` inside a fresh agent worktree.
  - `colony grab attach <task-id>` — convenience attach to the spawned tmux
    session.
  - `colony grab status` — list active grab sessions.
- ADD strict request gating on the daemon: 127.0.0.1 bind, bearer token,
  `Content-Type: application/json`, `Origin` allowlist, missing-Origin
  rejection. The daemon refuses non-loopback connections at the socket
  level.
- ADD in-memory dedup keyed by
  `sha256(repo_root|file_path|content|extra_prompt)` with a configurable
  window (default 5 minutes); repeat submits become `task_post` notes on
  the existing thread instead of new tasks.
- ADD per-run state under `$COLONY_HOME/grab/<token-fingerprint>.json`
  recording bind config, token fingerprint, recent dedup hashes, and
  spawned tmux session names.
- NO changes to the worker daemon, no new dependencies, no changes to MCP
  tools, no changes to the publish surface. Hono and `@hono/node-server`
  are already deps in `apps/cli`.

## Impact

- New surface: one CLI command tree, one HTTP daemon (off by default —
  requires explicit `colony grab serve`).
- Security risk if misconfigured: the daemon's `POST /grab` shells out
  `gx branch start` and `tmux new-session ... codex`, which is local code
  execution. Mitigations: 127.0.0.1-only bind, bearer token,
  `Content-Type: application/json` to force CORS preflight on browsers,
  `Origin` allowlist, missing-Origin rejection, and tests covering each
  boundary. The daemon never accepts a request that bypasses any one of
  these gates.
- No effect on existing `colony bridge lifecycle`, the worker daemon, or
  the MCP server. The grab daemon is a separate process per project.
- Performance budget: not in the hot path. `POST /grab` p95 ≤ 500 ms
  including worktree creation; the slow step is `gx branch start`.
