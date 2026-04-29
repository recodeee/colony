# Colony

<p align="center">
  <img src="docs/assets/colony-hero.svg" alt="Colony — local-first coordination for coding agents" width="860" />
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-111827.svg" /></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%3E%3D20-2563eb.svg" />
  <img alt="CLI: colony" src="https://img.shields.io/badge/cli-colony-16a34a.svg" />
  <img alt="MCP namespace: colony" src="https://img.shields.io/badge/mcp-colony-7c3aed.svg" />
</p>

**Colony is a local-first coordination substrate for fleets of AI coding agents.**

It helps Claude Code, Codex, Cursor, Gemini CLI, OpenCode, and other coding agents work in the same repository without losing context, duplicating work, or colliding on files. Agents use Colony to see active lanes, read attention items, pull ready work, claim files, hand off tasks, leave working notes, and let stale coordination signals decay.

Colony is not a remote control plane. The default path is local: SQLite, local files, hooks, and a stdio MCP server.

```text
OMX/Codex/Claude run agents.
Colony coordinates agents.
Queen publishes plans.
Agents pull claimable work.
Stale signals evaporate.
```

<p align="center">
  <img src="docs/assets/colony-architecture.svg" alt="Colony architecture diagram" width="900" />
</p>

---

## Why Colony exists

Most agent setups fail in the same ways:

- agents do not know who owns which files
- agents browse task lists instead of claiming ready work
- working state gets trapped in chat or scratchpads
- stale branches, handoffs, and claims stay noisy forever
- humans become the scheduler for parallel agents
- follow-up work disappears instead of becoming a proposal

Colony turns those behaviors into a measurable local loop:

```text
hivemind_context → attention_inbox → task_ready_for_agent → task_plan_claim_subtask → task_claim_file → task_note_working
```

Agents still execute in their normal runtime. Colony supplies the shared memory, task routing, ownership traces, and health telemetry.

---

## Current state

Colony is a pnpm monorepo with:

| Layer | What it does |
| --- | --- |
| CLI + installers | Registers Colony with Claude Code, Codex, Cursor, Gemini CLI, OpenCode, and other runtimes. |
| Hooks | Capture lifecycle, prompt, tool, and session events as local observations. |
| Storage + memory | Persist compressed observations, task threads, claims, handoffs, proposals, plans, and indexes. |
| MCP server | Exposes compact progressive-disclosure tools as `mcp__colony__...`. |
| Worker + viewer | Backfill embeddings and inspect local coordination state. |
| Queen | Publishes deterministic, claimable wave plans. Queen does not launch agents. |

Colony has moved beyond “memory search.” The current direction is **local multi-agent execution coordination**.

<p align="center">
  <img src="docs/assets/colony-loop.svg" alt="Colony startup and execution loop" width="900" />
</p>

---

## Install

```bash
npm install -g @imdeadpool/colony-cli
```

Register Colony with one or more runtimes:

```bash
colony install --ide claude-code
colony install --ide codex
colony install --ide cursor
colony install --ide gemini-cli
colony install --ide opencode
```

Check the install:

```bash
colony status
```

Requirements:

- Node.js 20+
- pnpm for repository development
- local SQLite state under `~/.colony`

---

## Daily workflow

```bash
colony health
colony health --fix-plan
colony status
colony search "error or decision"
colony coordination sweep --json
colony queen sweep
colony viewer
pnpm smoke:codex-omx-pretool
```

| Command | Purpose |
| --- | --- |
| `colony health` | Show readiness, adoption, stale signals, note migration, and claim-before-edit coverage. |
| `colony health --fix-plan` | Print the guided recovery sequence for execution-safety states such as `pre_tool_use_missing`, stale claims, and live contentions. Add `--apply` to run coordination and queen sweeps; it still does not release claims or install hooks. |
| `colony status` | Show storage, installed IDEs, worker state, memory counts, and embedding status. |
| `colony search "<query>"` | Search prior observations and session memory. |
| `colony timeline <session-id>` | Inspect one session chronologically. |
| `colony observe` | Watch task threads and coordination state. |
| `colony coordination sweep` | Report stale claims, expired handoffs/messages, decayed proposals, stale hot files, and blocked downstream work. |
| `colony queen sweep` | List plans that are stalled, unclaimed, or ready to archive. |
| `colony viewer` | Open the local read-only web viewer. |
| `colony install --ide <name>` | Register hooks and MCP config for one runtime. |
| `colony uninstall --ide <name>` | Remove installed hooks and MCP config. |
| `pnpm smoke:codex-omx-pretool` | Run a fresh Codex/OMX lifecycle smoke that binds a task, claims a real file, emits `pre_tool_use`, performs one edit, emits `post_tool_use`, and asserts claim-before-edit coverage. |

Installed Codex and Claude SessionStart hooks also inject the quota-safe operating contract: start with `hivemind_context`, then `attention_inbox`, then `task_ready_for_agent`; accept handoffs, claim subtasks/files before edits, keep `task_note_working` current, run focused verification, and emit a `quota_exhausted` handoff before quota/session stop with claimed files, dirty files, branch, last verification, and next step. Colony remains the coordination truth, OMX keeps runtime memory summaries, and available MCP servers provide repo/GitHub/CI/docs context.

---

## Health: the product feedback loop

`colony health` tells you whether agents are only reading Colony or actually coordinating through it.

<p align="center">
  <img src="docs/assets/colony-health.svg" alt="Colony health readiness summary" width="900" />
</p>

A healthy run should trend toward:

| Metric | Target |
| --- | --- |
| `hivemind_context → attention_inbox` | 50%+ |
| `attention_inbox → task_ready_for_agent` | 90%+ |
| `task_ready_for_agent → task_plan_claim_subtask` | 30%+ when plans exist |
| claim-before-edit | 50%+ |
| Colony note share | 70%+ |
| stale claims | near zero active-impact stale claims |

Readiness pillars:

| Pillar | Good means |
| --- | --- |
| Coordination readiness | Agents start with Colony and follow the startup loop. |
| Execution safety | Edits have a task/file claim before mutation. |
| Queen plan readiness | Multi-agent work has active, claimable wave plans. |
| Working-state migration | `task_note_working` beats ad hoc notepad writes. |
| Signal evaporation | Stale claims/proposals/handoffs decay instead of clogging work. |

---

### Codex/OMX pre-tool smoke

Run this when `pre_tool_use_missing` rises or when validating a Codex/OMX hook install:

```bash
pnpm smoke:codex-omx-pretool
```

The smoke uses an isolated temp git repo and Colony store. It starts a fresh Codex/OMX lifecycle session, binds an active task, records a manual claim for a real file path, emits `pre_tool_use`, mutates the file, emits `post_tool_use`, then asserts lifecycle order, claim-before-edit observation order, `pre_tool_use_signals > 0`, `edits_claimed_before > 0`, and no `pre_tool_use_missing` inside the same health window that `colony health` reads.

---

## Live colony graph

The local viewer can render the running coordination graph: active agent sessions, tool calls, handoffs, messages, file claims, stalled lanes, and shared work traces.

<p align="center">
  <img src="docs/assets/colony-graph-live.svg" alt="Colony live graph showing active agent sessions, MCP tool calls, handoffs, shares, and claims" width="900" />
</p>

Use it when you need to see the swarm instead of reading logs:

```bash
colony viewer
```

The graph is especially useful for spotting:

- active vs stalled lanes
- which agents are sharing or claiming work
- whether `task_ready_for_agent` is replacing `task_list`
- whether `task_note_working` is replacing ad hoc notepad writes
- stale traces that should decay or be swept

## MCP workflow

Installs register the MCP server as `colony`, so tools appear as `mcp__colony__...`.

Colony MCP uses progressive disclosure: tools return compact IDs, snippets, routing hints, and status rows first. Agents fetch full observation bodies only after they know which IDs matter.

### Startup loop

When an agent starts, resumes, asks “what needs me?”, or needs the next task:

1. `hivemind_context` — active agents, branches, live lanes, ownership, compact memory hits.
2. `attention_inbox` — handoffs, messages, blockers, wakes, stalled lanes, fresh claims, stale cleanup signals.
3. `task_ready_for_agent` — ready work matched to the current agent.

Do **not** choose work before `attention_inbox`.

Use `task_list` for browsing/debugging. Use `task_ready_for_agent` for work selection.

```json
{ "name": "hivemind_context", "input": { "repo_root": "/abs/repo", "query": "current task or branch", "memory_limit": 3, "limit": 20 } }
```

```json
{ "name": "attention_inbox", "input": { "session_id": "sess_abc", "agent": "codex", "repo_root": "/abs/repo" } }
```

```json
{ "name": "task_ready_for_agent", "input": { "session_id": "sess_abc", "agent": "codex", "repo_root": "/abs/repo", "limit": 5 } }
```

When plan work is claimable, `task_ready_for_agent` returns:

- `next_tool: "task_plan_claim_subtask"`
- exact copy-paste `claim_args` with `session_id`, `agent`, `repo_root`, `plan_slug`, `subtask_index`, and `file_scope`
- `reason`
- `next_action_reason`
- copy-paste MCP call

When nothing is claimable, it returns an empty state that tells the agent to publish a Queen/task plan for multi-agent work.

---

## Core MCP tools

### Memory and recall

| Tool | Use it for |
| --- | --- |
| `search` | Find prior decisions, errors, notes, and memory hits. |
| `get_observations` | Hydrate selected observation IDs into full bodies. |
| `list_sessions` | Find recent agent sessions. |
| `timeline` | Navigate one session around an observation. |
| `recall_session` | Pull a compact timeline from another session and audit that recall. |

### Live coordination

| Tool | Use it for |
| --- | --- |
| `hivemind` | See active agents, branches, task previews, and live lanes. |
| `hivemind_context` | Inspect active lane ownership before editing and before claiming files. |
| `attention_inbox` | See handoffs, messages, wakes, stalled lanes, fresh claims, and cleanup signals. |
| `task_list` | Browse/debug recent task threads. |
| `task_timeline` | Read compact task-thread activity. |
| `task_updates_since` | Check what changed while a session was away. |

### Task collaboration

| Tool | Use it for |
| --- | --- |
| `task_post` | Shared task notes, decisions, blockers, answers, or negative warnings. |
| `task_note_working` | Save current working state to the active Colony task without resolving `task_id`. |
| `task_message` | Directed or broadcast agent-to-agent message. |
| `task_messages` | Read compact message previews. |
| `task_message_mark_read` | Acknowledge a message and emit a read receipt. |
| `task_claim_file` | Claim a file before editing so ownership is visible. |
| `task_hand_off` | Transfer work and file claims. |
| `task_accept_handoff` / `task_decline_handoff` | Accept or decline pending handoffs. |

Use `task_message` for directed coordination. Use `task_post` for shared task-thread state.

Use `task_note_working` for compact handoffs:

```text
branch=<branch>; task=<task>; blocker=<blocker>; next=<next>; evidence=<path|command|PR|spec>
```

### Queen plans

| Tool | Use it for |
| --- | --- |
| `queen_plan_goal` | Turn a goal into an ordered plan draft. |
| `task_plan_publish` | Split a goal into claimable subtasks. |
| `task_plan_validate` | Check dependency and file-scope conflicts. |
| `task_plan_list` | See plans, rollups, and available subtasks. |
| `task_ready_for_agent` | Pick available work matched to the current agent. |
| `task_plan_claim_subtask` | Claim a ready subtask and file scope. |
| `task_plan_complete_subtask` | Mark a subtask complete and unlock downstream work. |

Queen is a deterministic plan publisher and sweeper. It does **not** launch agents or monitor shells. Agents pull unblocked work.

### Proposals and foraging

| Tool | Use it for |
| --- | --- |
| `task_propose` | Leave a weak candidate improvement for future work. |
| `task_reinforce` | Reinforce a proposal when another agent rediscovers or supports it. |
| `task_foraging_report` | Review pending and promoted proposals. |
| `examples_list` | List indexed example projects under `examples/`. |
| `examples_query` | Search indexed example patterns. |
| `examples_integrate_plan` | Produce a deterministic integration plan from an example into the target repo. |

Use proposals when a note says “future work,” “follow-up,” “deferred,” or “not in this change.” Reinforce rediscovered issues instead of burying them in chat.

---

## Biological coordination model

Colony uses the ant-colony model as an implementation guide, not as branding.

Agents do not wait for a global commander. They read local traces, reinforce useful signals, ignore stale ones, and pull work when context fits.

| Biology | Colony |
| --- | --- |
| Ant | agent session |
| Nest | repository |
| Trail pheromone | recent activity / claims / reinforced proposals |
| Stigmergic mark | task post / observation / file claim |
| Food source | useful example / bug fix / improvement |
| Forager | discovering agent |
| Recruitment | reinforce / handoff / message |
| Evaporation | TTL / decay / sweep |
| Response threshold | agent profile + ready-work ranking |
| Queen | plan publisher, not commander |
| Alarm pheromone | blocking message / attention inbox |
| Trail pruning | rescue / sweep / archive |

Practical effects:

- **Stale claim decay:** claims warn while fresh, then weaken and stop competing with active work.
- **Proposal reinforcement:** ignored proposals fade; source-diverse rediscovery strengthens them.
- **Queen ordered waves:** wave 2 can depend on wave 1 without Queen assigning shells.
- **Local context first:** agents hydrate only relevant observations after compact routing.

---

## Storage

Default state:

```text
~/.colony/settings.json
~/.colony/data.db
~/.colony/models/
~/.colony/logs/
```

SQLite stores the coordination substrate. Embeddings are lazy and local by default with `Xenova/all-MiniLM-L6-v2`; Ollama and OpenAI-style providers are opt-in through settings.

Persisted prose is compressed at rest through `@colony/compress` and expanded for human-facing reads. Technical tokens such as paths, URLs, code, commands, versions, dates, and numeric literals are preserved byte-for-byte.

---

## Repository layout

```text
apps/cli           user-facing colony binary
apps/mcp-server    stdio MCP server and tool registrations
apps/worker        local HTTP worker, viewer host, and embedding backfill
apps/hivemind-demo deterministic demo of coordination ideas
packages/config    settings schema, loader, defaults
packages/compress  deterministic compression engine
packages/core      MemoryStore facade and domain models
packages/embedding local, Ollama, OpenAI, and none providers
packages/foraging  example discovery, indexing, integration planning
packages/hooks     lifecycle hook handlers and active-session heartbeat
packages/installers per-runtime integration modules
packages/process   pidfile, spawn, entrypoint helpers
packages/queen     deterministic plan decomposition and sweeps
packages/spec      spec grammar, changes, scoped context
packages/storage   SQLite, FTS5, migrations, storage API
viewer             Vite/React read-only UI
hooks-scripts      portable shell stubs
docs               architecture and workflow docs
evals              compression and round-trip harnesses
```

---

## Development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Before merging changes:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Publish-path changes should also run:

```bash
bash scripts/e2e-publish.sh
```

### Publishing the CLI

Do not run `npm publish` from the repository root. Publish through the root wrapper:

```bash
pnpm publish:cli:dry-run
pnpm publish:cli
```

The wrapper builds the workspace, stages `README.md`, `LICENSE`, and `hooks-scripts/` into `apps/cli`, then runs `npm publish --access public` from `apps/cli`.

---

## Architecture rules

- Keep behavior local-first.
- Persist prose through `MemoryStore` so compression, privacy stripping, and storage invariants apply.
- Keep all database I/O inside `@colony/storage`.
- Keep settings access inside `@colony/config`.
- Keep MCP compact shapes compact; hydrate with `get_observations`.
- Keep hooks fast and free of network calls.
- Add tests for hooks, storage behavior, MCP contracts, installer changes, and compression rules.
- Keep CLI names, MCP namespace, package names, paths, and examples aligned on `colony`.

---

## Rough edges

- Claim-before-edit is strongest when the runtime provides a real pre-edit hook. Codex/OMX integrations may need a bridge when native PreToolUse is unavailable.
- Queen planning is active work: Queen publishes structure, but agents still need to claim and complete subtasks.
- Pheromone half-life, proposal thresholds, and routing weights need more tuning from real multi-agent use.
- MCP transport is stdio-based, so an IDE/runtime restart can close the server process; the next installed tool call should reconnect.
- The viewer is useful for inspection, but the primary workflow is terminal and agent driven.

---

## Roadmap

- Harden Codex/OMX claim-before-edit bridge.
- Publish and use active Queen wave plans for real multi-agent work.
- Expand task-thread and plan views in the local viewer.
- Tune pheromone half-life and proposal promotion thresholds from production usage.
- Add richer routing profiles for handoffs between Claude, Codex, Cursor, and other agents.
- Improve debrief output so follow-ups become proposals instead of chat-only notes.
- Harden migration from older installs into `~/.colony` and the `colony` MCP namespace.

---

## Contributing

Use Colony on real work, then report the places where coordination felt wrong:

- stale claims
- confusing handoffs
- missing session context
- noisy proposals
- stranded sessions
- files that should have shown up as hot
- edits that should have been claimed before mutation

For code changes, prefer small observable primitives over central orchestration. Colony should help agents coordinate by leaving durable local traces, not by becoming a remote control plane.

---

## License

MIT © Imdeadpool
