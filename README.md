# Colony

**Local-first memory and coordination for AI coding agents.**

<p align="center">
  <img src="docs/assets/colony-logo.png" alt="Colony logo" width="420" />
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-111827.svg" /></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%3E%3D20-2563eb.svg" />
  <img alt="CLI: colony" src="https://img.shields.io/badge/cli-colony-16a34a.svg" />
  <img alt="MCP namespace: colony" src="https://img.shields.io/badge/mcp-colony-7c3aed.svg" />
</p>

Colony lets Claude Code, Codex, Cursor, Gemini CLI, OpenCode, and other coding agents share memory, coordinate task ownership, and avoid stepping on each other while working in the same repository. It keeps the system local-first: observations, task threads, claims, handoffs, and search indexes live on your machine instead of requiring a hosted coordinator.

The design is ant-colony inspired on purpose. Agents do not need a central planner or direct messages to collaborate. They leave useful traces in a shared environment, then future agents react to those traces. That stigmergic model gives Colony a practical shape: active work leaves heat, repeated interest reinforces good follow-up tasks, and stale signals fade.

## What Colony Provides

- Persistent session memory across agent runs.
- MCP tools under the `colony` namespace.
- CLI commands under the `colony` binary.
- Local SQLite storage under `~/.colony`.
- IDE installers for Claude Code, Codex, Cursor, Gemini CLI, and OpenCode.
- Task threads for shared work, notes, answers, blockers, and decisions.
- File claims and handoffs so agents can coordinate without a human acting as dispatcher.
- Foraging-style proposals that can be reinforced into real work.
- Pheromone-style activity signals for hot files and recent focus.

## Install

```bash
npm install -g colony
```

Register Colony with your IDE or agent runtime:

```bash
colony install --ide claude-code
colony install --ide codex
colony install --ide cursor
colony install --ide gemini-cli
colony install --ide opencode
```

Check wiring:

```bash
colony status
```

Example status shape:

```text
Colony 0.2.0
data: ~/.colony/data.db
mcp namespace: colony
ides: claude-code, codex
memory: 1284 observations, 22 sessions
tasks: 3 active, 0 pending handoffs
embeddings: local / Xenova/all-MiniLM-L6-v2
```

## Daily Commands

| Command | Purpose |
| --- | --- |
| `colony install --ide <name>` | Register hooks and MCP config for one IDE/runtime. |
| `colony status` | Show storage, installed IDEs, worker state, and memory counts. |
| `colony search "<query>"` | Search prior observations and session memory. |
| `colony timeline <session-id>` | Inspect one session chronologically. |
| `colony observe` | Watch current task threads and coordination state. |
| `colony viewer` | Open the local web viewer. |
| `colony debrief` | Summarize recent work and surface follow-ups. |
| `colony config show` | Print current settings and documented defaults. |
| `colony uninstall --ide <name>` | Remove installed hooks and MCP config for one IDE/runtime. |

## MCP Namespace

IDE installs register the server as `colony`, so tool calls appear as `mcp__colony__...`.

Common tools:

| Tool | Purpose |
| --- | --- |
| `mcp__colony__search` | Find compact memory hits. |
| `mcp__colony__get_observations` | Fetch full observation bodies. |
| `mcp__colony__list_sessions` | List recent agent sessions. |
| `mcp__colony__timeline` | Read one session timeline. |
| `mcp__colony__hivemind` | Summarize active sessions and ownership. |
| `mcp__colony__task_list` | List task threads. |
| `mcp__colony__task_timeline` | Read task-thread events. |
| `mcp__colony__task_post` | Post a question, answer, decision, blocker, or note. |
| `mcp__colony__task_claim_file` | Claim file ownership on a task. |
| `mcp__colony__task_hand_off` | Transfer work and file claims to another agent. |
| `mcp__colony__task_foraging_report` | Review proposals that may become real tasks. |

## Storage

Default local state:

```text
~/.colony/settings.json
~/.colony/data.db
~/.colony/models/
~/.colony/logs/
```

Colony keeps memory local and uses SQLite for the coordination substrate. Embeddings are lazy: the local model downloads only when semantic search or backfill first needs it.

## The Coordination Model

Colony borrows three mechanisms from ant colonies.

**Pheromones:** file activity leaves decaying traces. Recent edits, claims, and task focus make hot areas visible without requiring permanent locks.

**Foraging:** agents can leave weak proposals for future improvements. Proposals that other agents reinforce become real work; proposals nobody touches fade out.

**Response thresholds:** handoffs can be scored against agent profiles so the best-fit agent sees stronger routing guidance, while ambiguous work remains available to any capable agent.

These mechanisms are intentionally simple. Colony favors observable signals, decay, and reinforcement over a central coordinator that has to know the whole plan.

## Rough Edges

- Older installs may still have the previous MCP namespace in IDE config; running `colony install --ide <name>` rewrites the active entry to `colony`.
- Pheromone and proposal thresholds need tuning from real multi-agent usage, not theoretical defaults.
- MCP transport is stdio-based, so IDE/runtime restarts can close the server process; the next tool call should reconnect through the installed config.
- The viewer is useful for inspection, but the primary workflow is still terminal/agent-driven.

## Roadmap

- Finish release hygiene for the renamed `colony` package.
- Expand task-thread views in the local viewer.
- Tune pheromone half-life and proposal promotion thresholds from real work.
- Add richer routing profiles for handoffs between Claude, Codex, Cursor, and other agents.
- Improve debrief output so useful follow-ups become proposals instead of chat-only notes.
- Harden migration from older installs into `~/.colony` and the `colony` MCP namespace.

## Contributing

Use Colony on real work, then report the exact places where coordination felt wrong: stale claims, confusing handoffs, missing session context, noisy proposals, or files that should have shown up as hot but did not.

For code changes:

1. Keep behavior local-first.
2. Prefer small, observable coordination primitives over central orchestration.
3. Add regression tests when changing hooks, storage, MCP tools, or CLI output.
4. Keep CLI, MCP namespace, package names, paths, and README examples aligned on `colony`.

## License

MIT © Imdeadpool
