# Proposal: Task Threads — From Synchronized Notebooks to Actual Collaboration

## Framing: two things that feel the same but aren't

Before jumping to features, it helps to separate two things that feel the same but aren't: **shared memory** and **shared coordination**.

The hivemind already nails the first one. Every Claude Code and Codex session writes observations into the same SQLite database, and any agent can call the `hivemind` MCP tool to see the live task previews, branches, and worktrees of every other agent running in the repo. That's genuinely more than most multi-agent setups manage.

What's missing is the second half. Right now agents are more like coworkers who keep synchronized notebooks than like coworkers who can actually talk. Claude can read what Codex wrote an hour ago, and can see that "Codex is currently on `agent/codex/viewer-task` with preview 'Render active lanes'," but there is no channel for Claude to say *to Codex specifically* "I'm about to touch `viewer.ts` — are you done there?" There's also no shared object that represents *the task itself*, separate from either agent's session. Each session is its own lane; the overlap is inferred from branch names and proxy-runtime telemetry rather than declared intent.

## The missing primitive: Task Thread

The improvement to push for is adding a first-class primitive the codebase doesn't have yet: the **Task Thread**. Think of it the way Slack thinks of a channel, or the way a PR thinks of a review conversation.

A task is a shared object that multiple sessions can *join*, and while they're joined, everything they post to the thread is visible to every participant as it happens. The existing `sessions` table represents one agent's run; a `tasks` table would represent one shared objective that two or more runs are collaborating on.

This is the structural change that converts "synchronized notebooks" into "actual collaboration," and most of the other improvements below fall out of it naturally.

## Current vs. proposed

### Current

- `sessions` table: one row per agent run.
- `observations` table: compressed prose, linked to a single session.
- `hivemind` MCP tool: lanes computed from `(repo_root, branch)` as a *read-only* awareness snapshot.
- Inter-agent awareness: asynchronous, inferential, passive.

### Proposed

- `tasks` table: one row per shared objective.
- `task_participants` join table: pairs `task_id` with `session_id`.
- Observations carry an optional `task_id` in metadata and a coordination `kind`.
- `SessionStart` auto-joins the session to any existing task for `(repo_root, branch)`.
- `UserPromptSubmit` injects new task-thread activity since the last turn.
- MCP exposes intent-named tools: `claim_file`, `ask_question`, `hand_off`, `record_decision`, `report_blocker`.
- Inter-agent awareness: turn-bounded, declarative, active.

## Concrete work

### 1. Schema additions

A new `tasks` table in the SQLite schema with columns like:

- `id`
- `title`
- `repo_root`
- `branch`
- `status`
- `created_by_session`
- `created_at`
- `updated_at`

Plus a `task_participants` join table pairing `task_id` with `session_id`.

### 2. Coordination `kind` values

New observation `kind` values dedicated to coordination:

- `claim`
- `question`
- `answer`
- `handoff`
- `decision`
- `blocker`
- `note`

Task-thread messages use the same compressed-content storage and FTS/embedding pipeline already built. No parallel messaging system is needed; a task message is just an observation whose `session_id` is the poster's session and which carries a `task_id` in metadata. That reuses all the compression, search, and memory infrastructure for free.

### 3. Auto-join on `SessionStart` (biggest leverage point)

The biggest leverage point is turning the existing `hivemind` awareness into a *join decision*.

Right now a Claude session that starts in `~/repo` on branch `agent/codex/viewer-task` has no idea that a Codex session is already running on the same branch. The logic that computes lane identity in `readHivemind` — `repo_root + branch` — is exactly the key to use to auto-join a session to a task.

On `SessionStart`, the hook should:

1. Check whether a task already exists for this `(repo_root, branch)` pair.
2. If so, add the current session as a participant.
3. Inject into `additionalContext` a line like:

   > "Codex is already joined to this task; last message 4 minutes ago was a `claim` on `src/viewer.ts`. Use `task_post` to coordinate before you touch overlapping files."

This is the moment where synchronized notebooks become real collaboration, because the new agent starts the turn already knowing there's someone to talk to and how to reach them.

### 4. MCP tools

Expose the collaboration through MCP so agents can actually *use* it. The existing MCP server already has the pattern down — see how `hivemind_context` combines lanes with memory hits in a single compact payload.

Add:

- `task_list`
- `task_timeline` — very similar to the existing `timeline`, just scoped to a task instead of a session
- `task_post` with a `kind` and optional `in_reply_to`
- `task_updates_since` — so an agent can poll for new messages from its collaborators without re-reading the whole thread

**Name the `task_post` variants by intent** — `claim_file`, `ask_question`, `hand_off`, `record_decision`, `report_blocker` — rather than one generic `post(kind)` tool. Named tools show up in the MCP tool list and become self-documenting affordances for the agent. When Claude sees a tool named `ask_question` in its tool menu, it'll actually use it. When it sees a generic `post(kind: "question")`, it usually won't.

## Real-time awareness: turn boundaries, not websockets

Resist the temptation to build a websocket or SSE system in v1. Agents don't really operate in continuous time — they operate in *turns*.

The cheapest high-value thing is to enrich the `UserPromptSubmit` hook to inject new task-thread activity into `additionalContext` whenever there's new activity on a joined task thread:

> "since your last turn, Codex posted a handoff on `src/viewer.ts` at 14:02"

That gives turn-boundary awareness with zero new infrastructure — just a query against the observations table filtered by task participation and a timestamp. The pipeline is already there; a second enrichment source sits next to the existing prior-session preface.

Push-based notifications via SSE on the worker is a reasonable v0.4, but the turn-boundary approach will cover 80% of what real-time feels like.

## Conflict detection

Conflict detection deserves its own small thought because it's where this system could become genuinely *better* than humans collaborating.

Every `PostToolUse` hook fires with the file paths the tool touched — `tool_input.file_path` for Edit, the list for MultiEdit, the target of Write. That's already flowing through the hook handler. What's missing is:

> Before the edit is *accepted* as a completed observation, the handler could check whether any other session currently participating in the same task holds an active claim on that file, and if so, inject a warning into the next turn's context.

Don't block the edit — in fact you shouldn't, because the claim is a social contract between agents rather than a lock. Just surface the collision the next time the agent opens its mouth.

Over time, this produces the habit: agents start calling `claim_file` before editing because the cost of stepping on each other becomes visible. The `apps/hivemind-demo` app is a miniature version of this pattern, just with deterministic agents in-process rather than real ones across sessions.

## Release plan

### v0.3

- `tasks` table and `task_participants` join table
- Coordination-kind observations
- `task_post` / `task_timeline` / `task_list` MCP tools
- Auto-join on `SessionStart`
- Turn-boundary new-message injection in `UserPromptSubmit`

Impact: converts the hivemind from a passive shared notebook into an active collaboration substrate. Roughly 500 lines of code spread across `@cavemem/core`, `@cavemem/storage`, `@cavemem/hooks`, and `@cavemem/mcp-server`.

### v0.4

- File claims and conflict warnings via `PostToolUse`

Impact: agents gain *situational awareness* rather than just shared history.

### v0.5

- SSE endpoint on the worker for push notifications
- "Join me" primitive where one agent can explicitly invite another to the same task

Useful once it's validated that agents actually want to collaborate on the same task rather than split into non-overlapping lanes.

### Beyond v0.5

Agreement protocols, voting, structured planning handed from coordinator to workers. This is where `apps/hivemind-demo` becomes a real design reference rather than a simulation: its Coordinator → Researcher → Builder → Reviewer → Verifier loop is a decent blueprint for what a *human-initiated* task might decompose into once the basic messaging layer is there.

## Why this is a short path

The reason this system is closer to this than it looks is that the hardest parts are already built:

- Shared durable store
- Per-session identity and branch/worktree metadata
- Hook integration across multiple IDEs
- MCP tools wired up
- Compression pipeline that won't blow up on chat volume
- `hivemind` runtime reader that figures out which sessions are actually live

What's missing is a single new primitive — the task thread — and the tooling around it. That's a very short path from "synchronized agents" to "collaborating agents," and nothing about it fights the existing architecture.
