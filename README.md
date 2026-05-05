# Colony

<p align="center">
  <img src="docs/assets/colony-hero.svg" alt="Colony — local-first coordination for coding agents" width="100%" />
</p>

<p align="center">
  <strong>Local-first coordination for fleets of coding agents.</strong><br/>
  Claims, handoffs, plans, health, and memory for Claude Code, Codex, Cursor, Gemini CLI, OpenCode, and other agent runtimes.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-111827.svg" /></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%3E%3D20-2563eb.svg" />
  <img alt="CLI: colony" src="https://img.shields.io/badge/cli-colony-16a34a.svg" />
  <img alt="MCP namespace: colony" src="https://img.shields.io/badge/mcp-colony-7c3aed.svg" />
</p>

```bash
npm install -g @imdeadpool/colony-cli
colony install --ide codex
colony health
```

Colony is **not a hosted control plane** and it does not run your agents. Codex,
Claude Code, Cursor, OMX, dmux, and other runtimes still execute work. Colony
is the shared local substrate they use to coordinate.

It is built for the expensive part of multi-agent work: avoiding repeated
context reloads. Claims, handoffs, timelines, and prior decisions stay compact
until an agent explicitly hydrates the full record. The result is measurable —
`colony gain` reports both the shared reference model below and live
`mcp_metrics` rows from your local MCP server.

> Runtimes run agents.
> **Colony** coordinates agents.
> Queen publishes claimable plans.
> Agents pull ready work.
> Stale signals evaporate.

<p align="center">
  <a href="#token-savings"><img alt="Cross-agent handoff: 99% saved" src="https://img.shields.io/badge/cross--agent%20handoff-99%25%20saved-10b981?style=flat-square&labelColor=022c22" /></a>
  <a href="#token-savings"><img alt="Search result shape: 97% saved" src="https://img.shields.io/badge/search%20result%20shape-97%25%20saved-10b981?style=flat-square&labelColor=022c22" /></a>
  <a href="#token-savings"><img alt="Find file owner: 92% saved" src="https://img.shields.io/badge/find%20file%20owner-92%25%20saved-10b981?style=flat-square&labelColor=022c22" /></a>
  <a href="#token-savings"><img alt="Startup sweep: 90% saved" src="https://img.shields.io/badge/startup%20sweep-90%25%20saved-10b981?style=flat-square&labelColor=022c22" /></a>
</p>

<p align="center">
  <em>Measured per-operation savings versus standard agent loops.</em>
  <a href="#token-savings"><strong>See the receipts &#8594;</strong></a>
</p>

---

## The Problem: One Failing Test, Two Agent Fixes

During a run, multiple agents can hit the same failing runtime-manifest test.
Without a shared coordination loop, each agent may independently diagnose the
same Turbopack root-escape bug, patch the same schema file, and race separate
PRs for one fix. Eventually one agent lands the repair, but the others have
already spent tokens, touched overlapping files, and created cleanup work.

<p align="center">
  <img src="docs/assets/colony-vs.svg" alt="Without Colony two agents collide on the same file. With Colony the second agent reads a live claim and stands down." width="100%" />
</p>

With Colony, both agents start from `hivemind_context`, `attention_inbox`, and
`task_ready_for_agent`. The first agent records the diagnosis, claims the
task and files, and posts the intended fix. The second agent sees the live
claim and prior diagnosis **before editing**, so it can stand down, review, or
take a different unclaimed lane.

Colony does not run the agents for you. It makes duplicate work visible early,
turns one solution into one implementation branch, and keeps the evidence in a
shared task thread.

| Without Colony                         | With Colony                                     |
| -------------------------------------- | ----------------------------------------------- |
| Agents collide on the same files.      | Agents claim files before edits.                |
| Agents chase the same failure alone.   | Agents pull ready subtasks from Colony.         |
| Progress is trapped in chat windows.   | Working state is saved to task threads.         |
| Old claims and handoffs stay noisy.    | Signals decay, expire, and can be swept.        |
| Follow-up ideas disappear.             | Proposals can be reinforced and promoted.       |
| Task lists become browsing surfaces.   | `task_ready_for_agent` becomes the work picker. |

---

## Token Savings

> **TL;DR — a single cross-agent handoff costs 30,000 tokens without Colony and 400 with it.**
> That's 99% saved on the most expensive coordination event in a multi-agent session,
> and Colony's `mcp_metrics` table records every one so the savings are _measured_, not estimated.

Coordination is where multi-agent runs burn tokens. Every handoff, every
"what was I working on", every "did someone already touch this file" turns
into a re-read of the repo, the chat, and the git log. Colony makes those
moments cheap by replacing replay with **one compact observation**.

<p align="center">
  <img src="docs/assets/colony-savings-vs.svg" alt="A handoff between two agents — without Colony costs 30,000 tokens of repo, git log, and chat replay; with Colony costs 400 tokens through one compact observation. 99% saved." width="100%" />
</p>

### Why It's Cheap

Six mechanisms compound. The big-bar wins below come from at least two of
them stacking on the same operation:

| Mechanism                  | What changes                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Compression at rest**    | Every observation runs through `@colony/compress` before SQLite. Prose shrinks ~70% while paths, URLs, code, commands, versions, and dates stay byte-for-byte intact. |
| **Progressive disclosure** | `search`, `timeline`, `attention_inbox`, `task_ready_for_agent` return compact IDs plus snippets. Full bodies only ship via `get_observations([ids])`.                |
| **Cross-session recall**   | Instead of re-reading 5–10 files plus `git log` to rederive a prior decision, agents `search` and pull one observation.                                               |
| **Claim-aware routing**    | `task_ready_for_agent` returns the next claimable action and exact claim args, so agents stop browsing task lists just to choose work.                                |
| **Stale-signal decay**     | Expired handoffs, weak claims, and stranded lanes surface as compact attention items instead of full historical transcripts.                                          |
| **Tiny handoffs**          | A durable handoff is `branch + task + blocker + next + evidence`, not a pasted session log.                                                                           |

### Where Colony Wins Hardest

Each row is a real coordination operation. The standard column is what the
same operation costs without a shared substrate (agents must replay context).
The Colony column is the measured cost through `mcp_metrics`.

<p align="center">
  <img src="docs/assets/colony-savings.svg" alt="Token savings bar chart: Colony reduces handoffs, search, ownership lookup, and coordination from thousands of tokens to hundreds" width="100%" />
</p>

| Operation                    | Standard | Colony |      Saved |
| ---------------------------- | -------: | -----: | ---------: |
| Cross-agent handoff          |   30,000 |    400 | **🟢 99%** |
| Quota-exhausted handoff      |   22,000 |    500 | **🟢 98%** |
| Search result shape          |    5,000 |    150 | **🟢 97%** |
| Unread message triage        |   10,000 |    600 | **🟢 94%** |
| Review task timeline         |   12,000 |    900 | **🟢 93%** |
| Find active owner for a file |    6,000 |    500 | **🟢 92%** |
| Ready-work selection         |    9,000 |    700 | **🟢 92%** |
| Plan subtask claim           |   12,000 |  1,100 |     🟢 91% |
| Startup coordination sweep   |   25,000 |  2,500 |     🟢 90% |
| Recover stranded lane        |   18,000 |  1,800 |     🟢 90% |
| Resume task across sessions  |   15,000 |  2,000 |     🟢 87% |
| Coordinate parallel agents   |   20,000 |  3,000 |     🟢 85% |

<details>
<summary><strong>Show all 21 operations</strong></summary>

| Operation                            | Frequency / session | Standard | Colony | Saved |
| ------------------------------------ | ------------------- | -------- | ------ | ----- |
| Cross-agent handoff                  | 2x                  | 30,000   | 400    | 99%   |
| Quota-exhausted handoff              | 1x                  | 22,000   | 500    | 98%   |
| Search result shape                  | 8x                  | 5,000    | 150    | 97%   |
| Unread message triage                | 4x                  | 10,000   | 600    | 94%   |
| Review task timeline                 | 4x                  | 12,000   | 900    | 93%   |
| Find active owner for a file         | 6x                  | 6,000    | 500    | 92%   |
| Ready-work selection                 | 3x                  | 9,000    | 700    | 92%   |
| Plan subtask claim                   | 2x                  | 12,000   | 1,100  | 91%   |
| Examples pattern lookup              | 2x                  | 11,000   | 1,000  | 91%   |
| Blocker recurrence                   | 2x                  | 10,000   | 900    | 91%   |
| Startup coordination sweep           | 1x                  | 25,000   | 2,500  | 90%   |
| Recover stranded lane                | 1x                  | 18,000   | 1,800  | 90%   |
| Claim-before-edit check              | 8x                  | 4,000    | 450    | 89%   |
| Spec context recall                  | 2x                  | 14,000   | 1,600  | 89%   |
| Health/adoption diagnosis            | 1x                  | 16,000   | 1,800  | 89%   |
| Drift / failed-verification recovery | 2x                  | 13,000   | 1,400  | 89%   |
| Resume task across sessions          | 3x                  | 15,000   | 2,000  | 87%   |
| Coordinate parallel agents           | 10x                 | 20,000   | 3,000  | 85%   |
| Why-was-this-changed                 | 4x                  | 8,000    | 1,200  | 85%   |
| Recall prior decision                | 5x                  | 8,000    | 1,500  | 81%   |
| Storage at rest (per observation)    | 1x                  | 1,000    | 300    | 70%   |

</details>

### See Your Own Numbers

The table above is the **reference model** — the shared baseline for what
these operations cost without Colony. The point of Colony is to give you
**live receipts** for the same operations in your own work. Three surfaces,
same data:

```bash
colony gain                       # CLI: live + reference, last 7 days
colony gain --hours 24 --json     # last 24 hours as JSON
colony gain --operation search    # filter live rows to one tool name
colony gain --session-limit 0     # every live session in the window
colony gain --input-cost-per-1m 1.25 --output-cost-per-1m 10
```

```json
{ "name": "savings_report", "input": { "hours": 24 } }
```

Or open `http://127.0.0.1:6510/savings` while `colony viewer` is running.
Add `?input_usd_per_1m=<usd>&output_usd_per_1m=<usd>`, set
`COLONY_MCP_INPUT_USD_PER_1M` / `COLONY_MCP_OUTPUT_USD_PER_1M`, or pass the
flags above to convert tokens into estimated USD per operation.

> **The receipt model.** Every wrapped MCP tool call writes a row to the
> `mcp_metrics` SQLite table with `(operation, ts, input_bytes, output_bytes,
input_tokens, output_tokens, duration_ms, ok, session_id, repo_root,
error_code, error_message)`. Cost is computed at _report time_ from those
> token receipts and the USD-per-1M rates you pass in, so older rows pick up
> cost visibility without a schema migration.

---

## The Colony Loop

Every agent session runs the same six-step coordination loop. **Compact first.
Hydrate only when needed. Claim before editing.**

<p align="center">
  <img src="docs/assets/colony-loop-animated.svg" alt="The Colony coordination loop: hivemind_context, attention_inbox, task_ready_for_agent, task_plan_claim_subtask, task_claim_file, task_note_working" width="100%" />
</p>

| #   | Step                      | What it does                                             |
| --- | ------------------------- | -------------------------------------------------------- |
| 1   | `hivemind_context`        | Who's active, what's hot, what's owned, recent memory.   |
| 2   | `attention_inbox`         | Handoffs, blockers, stale lanes that need attention.     |
| 3   | `task_ready_for_agent`    | Pull claimable work matched to this agent — not browse.  |
| 4   | `task_plan_claim_subtask` | Take exactly one unblocked wave slice from a Queen plan. |
| 5   | `task_claim_file`         | Make ownership visible **before** mutating the file.     |
| 6   | `task_note_working`       | Leave a compact resumable trail for the next session.    |

Steps 1–3 cost almost nothing (compact IDs and snippets). Full bodies only ship
when an agent explicitly calls `get_observations([ids])`. That's where the
token savings come from.

---

## How It Fits

Colony sits between the runtimes that execute work and the local SQLite store
that persists state. Queen is a peer, not a controller — it publishes
claimable plans, but agents still pull and complete the work themselves.

<p align="center">
  <img src="docs/assets/colony-architecture.svg" alt="Colony architecture: runtimes execute, Colony coordinates, Queen plans, all over a local SQLite substrate" width="100%" />
</p>

| Layer                                                | Responsibility                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| Codex / Claude Code / Cursor / Gemini CLI / OpenCode | Execute tools, edit files, run tests, talk to the user.                     |
| OMX / dmux / terminal sessions                       | Start sessions, panes, worktrees, and runtime process surfaces.             |
| **Colony**                                           | Route work, track claims, record handoffs, store memory, report health.     |
| Queen                                                | Publish deterministic wave plans; does not launch shells or command agents. |

This split keeps execution close to the existing agent runtime while making the
coordination state shared, inspectable, and local.

---

## Install

```bash
npm install -g @imdeadpool/colony-cli
```

Register one or more runtimes:

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

**Requirements:** Node.js 20+, pnpm for repository development, local SQLite
state under `~/.colony`.

---

## Daily Workflow

```bash
colony health                            # readiness, adoption, stale signals
colony health --fix-plan                 # guided recovery plan
colony status                            # storage, IDEs, worker, memory
colony search "error or decision"        # search prior observations
colony coordination sweep --json         # report stale claims, expired handoffs
colony queen sweep                       # find stalled or unclaimed plans
colony viewer                            # local read-only graph at :6510
pnpm smoke:codex-omx-pretool             # verify lifecycle bridge
pnpm smoke:health-repair-loop            # prove bridge + cleanup compose
```

Installed Codex and Claude hooks inject the quota-safe operating contract:
start with `hivemind_context`, then `attention_inbox`, then
`task_ready_for_agent`; accept or decline handoffs, claim files before edits,
keep `task_note_working` current, run focused verification, and hand off before
quota or session stop.

---

## Health

`colony health` shows whether agents are only **reading** Colony or actually
**coordinating** through it. The first screen is action-first: bad readiness
areas are grouped into the next exact command or MCP call. Lower-priority
follow-ups stay hidden until `--verbose`.

```text
Readiness summary
  coordination_readiness    good
  execution_safety          ok
  queen_plan_readiness      good
  working_state_migration   good
  signal_evaporation        good
```

Healthy runs trend toward:

| Metric                                            | Target                |
| ------------------------------------------------- | --------------------- |
| `hivemind_context -> attention_inbox`             | 50%+                  |
| `attention_inbox -> task_ready_for_agent`         | 90%+                  |
| `task_ready_for_agent -> task_plan_claim_subtask` | 30%+ when plans exist |
| claim-before-edit                                 | 50%+                  |
| Colony note share                                 | 70%+                  |
| stale claims                                      | near zero active      |

| If this is red            | First move                                                  |
| ------------------------- | ----------------------------------------------------------- |
| `coordination_readiness`  | Check agent startup loop adoption.                          |
| `execution_safety`        | Run `pnpm smoke:codex-omx-pretool` and verify hook install. |
| `queen_plan_readiness`    | Publish or repair claimable Queen plans.                    |
| `working_state_migration` | Use `task_note_working` instead of ad hoc notepads.         |
| `signal_evaporation`      | Run a dry sweep, then explicit safe stale-claim cleanup.    |

`execution_safety` includes a source-level `root_cause` in `--json` when edit
telemetry cannot be trusted:

| Root cause                     | Meaning                                                                       | First command                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `lifecycle_bridge_unavailable` | runtime/lifecycle bridge is unavailable                                       | `colony install --ide <ide>` then `pnpm smoke:codex-omx-pretool`                                  |
| `lifecycle_bridge_silent`      | bridge is available, but PreToolUse edit-path telemetry is empty or near-zero | `colony install --ide <ide>` then `colony health --hours 1 --json`                                |
| `lifecycle_paths_missing`      | PreToolUse exists, but edit events lack `file_path`                           | `colony bridge lifecycle --json --ide <ide> --cwd <repo_root> < colony-omx-lifecycle-v1.pre.json` |
| `lifecycle_claim_mismatch`     | paths exist, but claim metadata does not match edit scope                     | `colony bridge lifecycle --json --ide <ide> --cwd <repo_root> < colony-omx-lifecycle-v1.pre.json` |
| `no_hook_capable_edits`        | the selected window has no file edit events to diagnose                       | `colony health --hours 1 --json`                                                                  |

When `task_claim_file before edits` says `metric unreliable`, fix runtime
bridge or metadata first. Do not treat a bad claim ratio as agent discipline
until `omx_runtime_bridge.status` is fresh and edit events carry paths.

Safe stale-claim cleanup is opt-in because releasing a claim changes who may
edit a file:

```bash
colony health --fix-plan
colony coordination sweep --json
colony coordination sweep --release-safe-stale-claims --json
colony health --hours 1
```

---

## Signal Lifecycle

Colony follows a stigmergic model: agents leave local traces, other agents
react to useful traces, and stale traces evaporate.

<p align="center">
  <img src="docs/assets/colony-signal-lifecycle.svg" alt="Signal lifecycle: fresh traces guide, useful traces are reinforced, stale traces decay and are swept" width="100%" />
</p>

| Biology            | Colony                                |
| ------------------ | ------------------------------------- |
| ant                | agent session                         |
| nest               | repository                            |
| pheromone          | claim, proposal, handoff, message     |
| evaporation        | TTL, decay, sweep                     |
| response threshold | agent profile plus ready-work ranking |
| queen              | plan publisher, not commander         |

Practical effects:

- fresh claims warn other agents before they edit
- old claims weaken so they stop blocking current work
- proposals can be reinforced instead of lost
- Queen waves unlock in order without assigning shells
- agents hydrate only relevant observation bodies after compact routing

---

## What Colony Can Do Right Now

| Capability                 | Current surface                                                                 |
| -------------------------- | ------------------------------------------------------------------------------- |
| Install runtime hooks      | `colony install --ide claude-code`, `codex`, `cursor`, `gemini-cli`, `opencode` |
| Capture local observations | lifecycle hooks, prompt events, tool events, session heartbeat                  |
| Search prior work          | `colony search`, MCP `search`, `timeline`, `get_observations`                   |
| See active lanes           | MCP `hivemind_context`, `attention_inbox`, CLI coordination reports             |
| Claim work safely          | `task_ready_for_agent`, `task_plan_claim_subtask`, `task_claim_file`            |
| Coordinate agents          | `task_post`, `task_message`, handoffs, working notes                            |
| Publish wave plans         | Queen plans and `task_plan_*` MCP tools                                         |
| Clean stale signals        | `colony coordination sweep`, `colony queen sweep`, health fix plans             |
| Inspect the graph          | `colony viewer` local read-only graph                                           |
| Measure token savings      | `colony gain`, MCP `savings_report`, viewer `/savings`                          |
| Prove behavior             | `colony health`, smoke tests, adoption metrics                                  |

Use Colony when you run more than one coding agent in the same repo, use
worktrees or parallel branches, need local-first memory, or want stale claims
and handoffs to stop shaping current work.

---

## MCP Quick Reference

Installs register the MCP server as `colony`, so tools appear as
`mcp__colony__...`. Colony MCP uses progressive disclosure: compact IDs,
snippets, routing hints, and status rows first; full observation bodies only
when requested.

| Tool                      | Use                                                                  |
| ------------------------- | -------------------------------------------------------------------- |
| `hivemind_context`        | Start/resume with active lanes, ownership, hot files, memory hits.   |
| `attention_inbox`         | See handoffs, messages, blockers, stale cleanup, stalled lanes.      |
| `task_ready_for_agent`    | Pull claimable work matched to the agent.                            |
| `task_plan_claim_subtask` | Claim a Queen subtask and its file scope.                            |
| `task_claim_file`         | Make ownership visible before editing.                               |
| `task_note_working`       | Save compact resumable state.                                        |
| `task_message`            | Send directed or broadcast agent coordination messages.              |
| `task_foraging_report`    | Review weak proposals and promoted future work.                      |
| `savings_report`          | Live mcp_metrics rows + reference model; same data as `colony gain`. |

Copy-paste startup:

```json
{
  "name": "hivemind_context",
  "input": {
    "repo_root": "/abs/repo",
    "query": "current task or branch",
    "memory_limit": 3,
    "limit": 20
  }
}
```

```json
{
  "name": "attention_inbox",
  "input": {
    "session_id": "sess_abc",
    "agent": "codex",
    "repo_root": "/abs/repo"
  }
}
```

```json
{
  "name": "task_ready_for_agent",
  "input": {
    "session_id": "sess_abc",
    "agent": "codex",
    "repo_root": "/abs/repo",
    "limit": 5
  }
}
```

When plan work is claimable, `task_ready_for_agent` returns
`next_tool: "task_plan_claim_subtask"` plus exact `claim_args`. When no work
is claimable, it returns an empty state that tells the agent to publish a
Queen/task plan for multi-agent work.

Full MCP catalog: [docs/mcp.md](docs/mcp.md)

---

## Storage

Default local state:

```text
~/.colony/settings.json
~/.colony/data.db
~/.colony/models/
~/.colony/logs/
```

SQLite stores the coordination substrate. Embeddings are lazy and local by
default with `Xenova/all-MiniLM-L6-v2`; Ollama and OpenAI-style providers are
opt-in through settings. Persisted prose is compressed at rest through
`@colony/compress`; technical tokens such as paths, URLs, code, commands,
versions, dates, and numeric literals are preserved byte-for-byte.

---

## Repository Layout

```text
apps/cli             user-facing colony binary
apps/mcp-server      stdio MCP server and tool registrations
apps/worker          local HTTP worker, viewer host, embedding backfill
packages/core        MemoryStore facade and domain models
packages/storage     SQLite, FTS5, migrations, storage API
packages/hooks       lifecycle hook handlers and active-session heartbeat
packages/installers  per-runtime integration modules
packages/queen       deterministic plan decomposition and sweeps
packages/spec        spec grammar, changes, scoped context
docs                 architecture and workflow docs
```

Deeper docs:

- [Architecture](docs/architecture.md)
- [MCP tools](docs/mcp.md)
- [Queen plans](docs/QUEEN.md)
- [Compression](docs/compression.md)
- [Development](docs/development.md)
- [Proposal task threads](docs/proposal-task-threads.md)

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

````bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build


---

## Architecture Rules

- Keep behavior local-first.
- Persist prose through `MemoryStore` so compression, privacy stripping, and storage invariants apply.
- Keep all database I/O inside `@colony/storage`.
- Keep settings access inside `@colony/config`.
- Keep MCP compact shapes compact; hydrate with `get_observations`.
- Keep hooks fast and free of network calls.
- Add tests for hooks, storage behavior, MCP contracts, installer changes, and compression rules.
- Keep CLI names, MCP namespace, package names, paths, and examples aligned on `colony`.

---

## Rough Edges

- Claim-before-edit is strongest when the runtime provides a real pre-edit hook. Codex/OMX integrations may need a bridge when native PreToolUse is unavailable.
- Queen planning is active work: Queen publishes structure, but agents still need to claim and complete subtasks.
- Pheromone half-life, proposal thresholds, and routing weights need tuning from real multi-agent use.
- MCP transport is stdio-based, so an IDE/runtime restart can close the server process; the next installed tool call should reconnect.
- The viewer is useful for inspection, but the primary workflow is terminal and agent driven.

---

## Roadmap: Toward a Self-Healing System

Today, `colony health` _reports_ what's wrong. Tomorrow, it should _fix_ what's
wrong. The end state is a coordination substrate that detects, diagnoses, and
repairs itself — so multi-agent fleets stay healthy without a human running
sweep commands by hand.

<p align="center">
  <img src="docs/assets/colony-roadmap.svg" alt="Roadmap: Colony evolves from observe-and-report (now) to propose-and-apply (next) to fully autonomous heal (future). Time-to-healthy trends from hours to seconds." width="100%" />
</p>

### Where We Are (`v0.x` — observe & report)

The current substrate is honest: it tells you the truth and gives you the
exact command to fix it. From a real run on a busy repo right now:

```text
At a glance
  overall: needs attention (2 areas)
  fix first: live file contentions
  because: 16 conflict(s), 0 dirty
  signal_evaporation: 81 stale claim(s); 139 quota-pending claim(s)
````

Colony already detects same-file multi-owner claims, lifecycle path
mismatches, claims on protected branches, expired handoffs, and decaying
proposals. Every problem comes with a `cmd:` and a `tool:` line. **The human
still presses the button.** That is the gap the roadmap closes.

### Phase 1: Propose & One-Click Apply (`v1`)

The first jump is making `--fix-plan` executable instead of just printable.

| Capability                   | Closes which gap                                                                               | Surface          |
| ---------------------------- | ---------------------------------------------------------------------------------------------- | ---------------- |
| **`colony heal --apply`**    | Today `colony health --fix-plan` prints commands. `--apply` runs them with a dry-run first.    | CLI              |
| **Contention auto-resolver** | 16 same-file multi-owner claims sit in protected state. Deterministic policies clear them.     | sweep + MCP tool |
| **Branch policy guard**      | 11 claims live on `dev` / `main`. Reject these at claim time and prompt `gx branch start`.     | MCP tool, hook   |
| **Quota relay auto-release** | 139 quota-pending claims expire silently. Auto-release after grace period, audit retained.     | worker           |
| **Lifecycle reclaim**        | `path_mismatch` is the dominant reason claims drift from edits. Reclaim on path divergence.    | hook             |
| **Plan-claim nudge**         | `task_ready_for_agent → task_plan_claim_subtask` is at 0% adoption. Surface claim args inline. | startup hook     |

Concrete next contracts:

```text
colony heal --apply --dry-run        # show what would change
colony heal --apply --safe-only      # only stale-signal sweeps and quota-release
colony heal --apply --policy=auto    # contention rules + branch guard
```

A successful `colony heal --apply` writes its own audit observations so the
repair itself is searchable later. **Repair is data, not a side-effect.**

### Phase 2: Continuous Background Healing (`v2`)

Move the loop off the terminal entirely.

| Capability                      | What it does                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **`colony worker --heal`**      | Background daemon (already host for the viewer) runs sweep + safe-fix loop on a configurable cadence.               |
| **Adaptive half-life tuning**   | Pheromone TTLs adjust per repo from observed reinforcement rates instead of a global default.                       |
| **Predictive routing**          | `task_ready_for_agent` ranks claimable work using `mcp_metrics` history: who finishes which kind of file fastest.   |
| **Specialist routing**          | Hot files learn their best-fit agent (e.g. test files → Codex, prose → Claude) from prior outcomes.                 |
| **Auto-promote weak proposals** | Proposals that get reinforced past a learned threshold are promoted to claimable Queen subtasks automatically.      |
| **Failure pattern memory**      | Drift / failed-verification events accumulate as searchable patterns; agents see "this kind of edit failed before". |

The trigger for _not_ doing something stays human: any auto-action lands as a
proposal first, gets a short evaporation window, and only applies if no human
or agent objects.

### Phase 3: Federated Colonies (`v3+`)

Once a single repo's substrate is healing itself, the next surface is across
repos:

- **Cross-repo memory sync.** Opt-in pheromone exchange so a fix discovered in
  one repo propagates as a _suggestion_ to similar code in another, while
  observation bodies stay local-first.
- **Team substrates.** A team-wide read-only view that aggregates anonymized
  health and adoption metrics across personal repos, useful for tooling teams
  to spot integration gaps without collecting source.
- **Replay & rewind.** Treat the SQLite log as event-sourced enough to
  reconstruct any past coordination state. Useful for incident review and for
  testing healing policies against historical data.
- **Policy as code.** `colony.policy.yaml` declaring allowed auto-actions, TTL
  ranges, branch rules, takeover thresholds — version-controlled with the
  repo, audited like any other config.

### North-Star Metric: Time-to-Healthy

Every roadmap item is judged against one number: **how long does it take
Colony to detect and repair a regression without human intervention?**

| Phase | Time-to-Healthy     | Trigger                                                                |
| ----- | ------------------- | ---------------------------------------------------------------------- |
| v0.x  | hours (human-paced) | someone notices, runs `colony health --fix-plan`, copy-pastes commands |
| v1    | minutes             | `colony heal --apply` runs on the first agent's startup or on demand   |
| v2+   | seconds             | continuous worker loop catches regressions before they propagate       |

If a contention sits unresolved for two hours today and for two seconds in v2,
that's the win. Everything else — federated memory, predictive routing, policy
files — is a means to that end.

### What Stays the Same

These are non-goals, even at v3+:

- **Local-first by default.** Colony never becomes a hosted control plane. Federation is opt-in and observation bodies stay on the local disk unless the user explicitly syncs them.
- **Colony does not run agents.** Healing means changing coordination state (claims, handoffs, proposals, sweeps), not launching shells or commanding agents to do work.
- **Stigmergy over orchestration.** Auto-fixes leave traces (claims, proposals, handoffs) the same way a human or agent would, so the substrate stays inspectable and reversible.
- **Receipts are the truth.** Every healing action writes to `mcp_metrics` and observations. If you can't `colony search` it later, it didn't happen.

If any of these constraints break, the system stops being Colony and starts
being a different product.

---

## Contributing

Use Colony on real work, then report the places where coordination felt wrong:
stale claims, confusing handoffs, missing session context, noisy proposals,
stranded sessions, hot files that were missed, or edits that should have been
claimed before mutation.

For code changes, prefer small observable primitives over central
orchestration. Colony should help agents coordinate by leaving durable local
traces, not by becoming a remote control plane.

---

## License

MIT © Imdeadpool
