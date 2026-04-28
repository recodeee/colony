# Colony

**Local-first memory, coordination, and work routing for AI coding agents.**

<p align="center">
  <img src="docs/assets/colony-logo.png" alt="Colony logo" width="420" />
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-111827.svg" /></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%3E%3D20-2563eb.svg" />
  <img alt="CLI: colony" src="https://img.shields.io/badge/cli-colony-16a34a.svg" />
  <img alt="MCP namespace: colony" src="https://img.shields.io/badge/mcp-colony-7c3aed.svg" />
</p>

Colony helps Claude Code, Codex, Cursor, Gemini CLI, OpenCode, and other coding agents work in the same repository without losing context or colliding on files. It records what agents observed, what task they are on, which files they claimed, what they handed off, and which follow-up work is worth doing next.

The important part: Colony is local-first. The coordination substrate lives on your machine in SQLite, local files, and a stdio MCP server. There is no hosted coordinator in the default path, and hooks keep writing useful memory even when the worker or semantic index is unavailable.

## Current State

Colony is currently a pnpm monorepo with a published CLI, a stdio MCP server, lifecycle hooks, a local worker/viewer, and a set of workspace packages that implement memory, compression, storage, embeddings, task coordination, foraging, spec-driven changes, and deterministic plan publishing.

The app today is best understood as five connected layers:

1. **CLI and installers** wire Colony into agent runtimes.
2. **Hooks** capture session events and write observations synchronously.
3. **Storage and memory** persist compressed observations, tasks, claims, handoffs, proposals, and indexes.
4. **MCP tools** expose compact, progressive-disclosure workflows to agents.
5. **Worker and viewer** handle background embedding/backfill and local inspection.

The newest design direction is no longer just "memory search." Colony is becoming a local coordination substrate where agents can ask:

- What changed while I was away?
- Who is editing this area?
- What work is ready for me?
- Which sub-task can I safely claim?
- What should be handed off, rescued, reinforced, or archived?

## Install

```bash
npm install -g @imdeadpool/colony-cli
```

Register Colony with one or more agent runtimes:

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

Colony requires Node 20 or newer. The CLI package is `@imdeadpool/colony-cli`; the executable is `colony`.

## Daily CLI

| Command | Purpose |
| --- | --- |
| `colony install --ide <name>` | Register hooks and MCP config for one IDE/runtime. |
| `colony status` | Show storage, installed IDEs, worker state, memory counts, and embedding status. |
| `colony search "<query>"` | Search prior observations and session memory. |
| `colony timeline <session-id>` | Inspect one session chronologically. |
| `colony observe` | Watch task threads and coordination state. |
| `colony coordination sweep` | Report stale claims, expired handoffs/messages, decayed proposals, stale hot files, and blocked downstream work. |
| `colony plan create <slug>` | Create an OpenSpec-like local plan workspace under `openspec/plans/<slug>`. |
| `colony plan status [slug]` | Inspect local plan tasks, checkpoints, and rollup counts. |
| `colony plan publish <slug>` | Publish a local plan workspace into Colony task threads and `openspec/changes`. |
| `colony plan close <slug>` | Archive a completed published plan change. |
| `colony viewer` | Open the local read-only web viewer. |
| `colony debrief` | Summarize recent work and surface follow-ups. |
| `colony config show` | Print settings and documented defaults. |
| `colony queen sweep` | List queen plans that are stalled, unclaimed, or ready to archive. |
| `colony uninstall --ide <name>` | Remove installed hooks and MCP config for one IDE/runtime. |

## What Agents Get Through MCP

IDE installs register the server as `colony`, so tools appear as `mcp__colony__...`.

Colony MCP follows progressive disclosure: tools return compact IDs, snippets, status rows, and routing hints first. Agents fetch full observation bodies only after they know which IDs matter.

### Agent startup loop

When an agent joins, resumes, asks "what needs me?", or needs the next task, call these first:

1. `hivemind_context` to see active agents, owned branches, live lanes, and compact memory hits.
2. `attention_inbox` to see what needs your attention: live handoffs, messages, wakes, stalled lanes, and recent claim activity.
3. `task_ready_for_agent` to choose available work matched to the current agent.

Use `task_list` for browsing/debugging recent task threads. Use `task_ready_for_agent` for choosing what to work on next.

Copy-paste startup:

```json
{ "name": "hivemind_context", "input": { "repo_root": "/abs/repo", "query": "current task or branch", "memory_limit": 3, "limit": 20 } }
```

```json
{ "name": "attention_inbox", "input": { "session_id": "sess_abc", "agent": "codex", "repo_root": "/abs/repo" } }
```

```json
{ "name": "task_ready_for_agent", "input": { "session_id": "sess_abc", "agent": "codex", "repo_root": "/abs/repo", "limit": 5 } }
```

If the ready item needs implementation context, call `search` with the task title, files, or error phrase, then hydrate only the needed IDs with `get_observations`. Before editing, inspect ownership, then claim touched files on the active task with `task_claim_file` or `task_plan_claim_subtask`. Claims are warnings, not locks; they help avoid conflict and do not block writes.

### Memory and session recall

| Tool | Use it for |
| --- | --- |
| `search` | Find prior decisions, errors, notes, and compact memory hits. |
| `get_observations` | Hydrate selected observation IDs into full bodies. |
| `list_sessions` | Find recent agent sessions. |
| `timeline` | Navigate one session around an observation. |
| `recall_session` | Pull a compact timeline from another session and audit that recall. |

### Live coordination

| Tool | Use it for |
| --- | --- |
| `hivemind` | See active agents, branches, task previews, and live lanes. |
| `hivemind_context` | Inspect active lane ownership before editing and before claiming touched files. |
| `attention_inbox` | See live pending handoffs, messages, wakes, stalled lanes, and recent claims. |
| `task_list` | Browse/debug recent task threads by repo, branch, and status. |
| `task_timeline` | Read compact task-thread activity. |
| `task_updates_since` | Check what changed on a task while a session was away. |

### Task collaboration

| Tool | Use it for |
| --- | --- |
| `task_post` | Add a question, answer, decision, blocker, note, or explicit negative warning to a task; use `kind:"note"` to write working state. |
| `task_note_working` | Save current working state to the active Colony task without manually resolving `task_id`. |
| `task_message` | Send a directed or broadcast message to another agent. |
| `task_messages` | Read compact message previews; expired rows only surface for audit-style listing. |
| `task_message_mark_read` | Acknowledge a message and emit a read receipt; expired rows return `MESSAGE_EXPIRED`. |
| `task_message_claim` | Claim a broadcast message before replying. |
| `task_message_retract` | Retract a message that has not been replied to. |
| `task_claim_file` | Claim a file before editing so file ownership is visible and overlaps warn, not lock. |
| `task_hand_off` | Transfer work and file claims to another agent; pending handoffs expire by default after 120 minutes. |
| `task_accept_handoff` / `task_decline_handoff` | Accept or decline pending handoffs; expired handoffs return `HANDOFF_EXPIRED`. |

Negative warning kinds are `failed_approach`, `blocked_path`, `conflict_warning`, and `reverted_solution`. Use them only when another agent should avoid repeating a concrete path: failed paths, blocked approaches, reverted solutions, flaky routes, or do-not-touch warnings. `search`, `hivemind_context`, and `task_ready_for_agent` surface relevant warnings compactly before implementation; they do not penalize ready-work ranking or turn ordinary trial-and-error into blockers.

### Proposals, foraging, and examples

| Tool | Use it for |
| --- | --- |
| `task_propose` | Leave a weak candidate improvement for future work. |
| `task_reinforce` | Reinforce a proposal when another agent rediscovers or supports it. |
| `task_foraging_report` | Review pending and promoted proposals. |
| `examples_list` | List indexed example projects discovered under `examples/`. |
| `examples_query` | Search indexed example code patterns. |
| `examples_integrate_plan` | Produce a deterministic integration plan from an example into the target repo. |

### Plans and queen

| Tool | Use it for |
| --- | --- |
| `task_plan_publish` | Split a larger goal into claimable sub-tasks. |
| `task_plan_validate` | Check dependency and file-scope conflicts before publishing. |
| `task_plan_list` | See published plans, rollups, and available sub-tasks. |
| `task_ready_for_agent` | Pick available work matched to the current agent. |
| `task_plan_claim_subtask` | Claim a ready sub-task and its file scope. |
| `task_plan_complete_subtask` | Mark a sub-task complete and unlock downstream work. |

Queen is the deterministic plan publisher and sweeper behind this workflow. It is not an orchestrator and does not launch agents. It turns a clear goal into a bounded, claimable plan, then agents pull work through the normal Colony task-plan tools. The CLI `colony queen sweep` surfaces stalled claimed work, long-unclaimed available subtasks, and completed plans waiting on manual archive. See [Queen workflow](docs/QUEEN.md).

### Spec-driven development

| Tool | Use it for |
| --- | --- |
| `spec_read` | Read a repository `SPEC.md` and root hash. |
| `spec_change_open` | Open an in-flight spec change and backing task thread. |
| `spec_change_add_delta` | Append a delta to the change. |
| `spec_build_context` | Load cite-scoped context for one spec task. |
| `spec_build_record_failure` | Record test failures and promote repeated failures into invariant proposals. |
| `spec_archive` | Validate, three-way merge, and archive an in-flight spec change. |

## Biological Coordination Model

Colony uses the ant-colony model as an implementation guide, not as branding.
Agents do not wait for a global commander. They read local traces, reinforce
useful signals, ignore stale ones, and pull work when the current context fits.
The durable behavior contract lives in
[`openspec/specs/biological-coordination/spec.md`](openspec/specs/biological-coordination/spec.md);
this README is the contributor-facing summary.

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

Practical examples:

- **Stale claim decay:** `task_claim_file` leaves a local mark so nearby agents
  see fresh ownership before editing. Claims warn; they do not lock. When the
  session goes stale, rescue and sweep move or hide the trail so old ownership
  stops competing with live work.
- **Proposal reinforcement and decay:** a forager calls `task_propose` for a bug
  fix or improvement. Other sessions use `task_reinforce` when they support or
  independently rediscover it; adjacent edits add weak support. Strength decays
  over time, so ignored proposals fade while source-diverse proposals promote.
- **Queen ordered waves:** Queen publishes a `task_plan` with dependencies, for
  example wave 2 depending on wave 1. It does not launch workers or assign
  shells. Agents pull unblocked subtasks with `task_ready_for_agent` and claim
  with `task_plan_claim_subtask`.
- **Local context before editing:** startup is `hivemind_context`,
  `attention_inbox`, then `task_ready_for_agent`. Hydrate only the relevant
  observations with `get_observations`, inspect ownership, then claim files.
  Compact first, full context only when needed.

Hooks keep this local. They write observations synchronously through
`MemoryStore` without a hosted coordinator or daemon dependency. The worker can
backfill embeddings later; if it is down, writes still succeed and keyword
search still works.

## Storage

Default local state:

```text
~/.colony/settings.json
~/.colony/data.db
~/.colony/models/
~/.colony/logs/
```

SQLite stores the coordination substrate. Embeddings are lazy and local by default using `Xenova/all-MiniLM-L6-v2`; Ollama and OpenAI-style providers are opt-in through settings.

Persisted prose is compressed at rest through `@colony/compress` and expanded for human-facing reads. Technical tokens such as paths, URLs, code, commands, versions, dates, and numeric literals are preserved byte-for-byte.

## Repository Layout

```text
apps/cli          user-facing `colony` binary
apps/mcp-server   stdio MCP server and tool registrations
apps/worker       local HTTP worker, viewer host, and embedding backfill
apps/hivemind-demo deterministic demo of multi-agent coordination ideas
packages/process  pidfile, spawn, and entrypoint helpers
packages/config   settings schema, loader, defaults, and settings docs
packages/compress deterministic compression engine and tokenizer
packages/storage  SQLite, FTS5, migrations, and storage API
packages/core     MemoryStore facade and coordination domain models
packages/embedding local, Ollama, OpenAI, and none providers
packages/hooks    lifecycle hook handlers and active-session heartbeat
packages/installers per-IDE integration modules
packages/foraging example discovery, indexing, and integration planning
packages/spec     spec grammar, change sync, backprop, and scoped context
packages/queen    deterministic plan decomposition and plan attention sweep
viewer            Vite/React read-only UI
hooks-scripts     portable shell stubs for hook entrypoints
docs              architecture and workflow docs
evals             compression and round-trip evaluation harness
```

## Development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

The root package is private and uses pnpm workspaces. The main package manager is `pnpm@9.12.0`.

Before merging changes, keep the four normal gates green:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Publish-path changes should also run:

```bash
bash scripts/e2e-publish.sh
```

### Publishing the CLI

Do not run `npm publish` from the repository root. The root package is the private monorepo wrapper. Publish the public CLI package through the root wrapper instead:

```bash
pnpm publish:cli:dry-run
pnpm publish:cli
```

The wrapper builds the workspace, stages the root `README.md`, `LICENSE`, and `hooks-scripts/` into `apps/cli`, then runs `npm publish --access public` from the `@imdeadpool/colony-cli` package directory.

## Architecture Rules

- Keep behavior local-first.
- Persist prose only through `MemoryStore` so compression, privacy stripping, and storage invariants apply.
- Keep all database I/O inside `@colony/storage`.
- Keep settings access inside `@colony/config`.
- Keep MCP compact shapes compact; hydrate through `get_observations`.
- Keep hooks fast and free of network calls.
- Add tests for new hooks, storage behavior, MCP contracts, installer changes, and compression rules.
- Keep CLI names, MCP namespace, package names, paths, and examples aligned on `colony`.

## Rough Edges

- The old `cavemem` name may still appear in history, changelogs, or old installs. New installs use `colony`, the `@colony/*` workspace namespace, and `@imdeadpool/colony-cli` for the published CLI.
- Pheromone half-life, proposal thresholds, and routing weights need more tuning from real multi-agent use.
- MCP transport is stdio-based, so an IDE/runtime restart can close the server process; the next installed tool call should reconnect.
- The viewer is useful for inspection, but the primary workflow is still terminal and agent driven.
- Spec-driven development and queen planning are active lanes. They use the existing Colony substrate instead of parallel infrastructure, but some niceties are still intentionally thin while the core loop proves itself.

## Demo App

`apps/hivemind-demo` is a private pedagogical artifact. It models a deterministic multi-agent loop in-process so coordination ideas can be tested without launching real IDE agents.

## Roadmap

- Finish release hygiene for the renamed `colony` package.
- Expand task-thread views in the local viewer.
- Tune pheromone half-life and proposal promotion thresholds from real work.
- Add richer routing profiles for handoffs between Claude, Codex, Cursor, and other agents.
- Improve debrief output so useful follow-ups become proposals instead of chat-only notes.
- Harden migration from older installs into `~/.colony` and the `colony` MCP namespace.
- Expand `colony plan` from local planning workspaces into richer viewer and handoff flows.

## Contributing

Use Colony on real work, then report the exact places where coordination felt wrong: stale claims, confusing handoffs, missing session context, noisy proposals, missing examples, stranded sessions, or files that should have shown up as hot but did not.

For code changes, prefer small, observable primitives over central orchestration. Colony should help agents coordinate by leaving durable local traces, not by becoming a remote control plane.

## License

MIT © Imdeadpool
