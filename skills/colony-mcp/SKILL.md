---
name: colony-mcp
description: Coordinate repository work through Colony MCP. Use when an agent starts, resumes, chooses work, claims files, hands off work, records working state, or finishes a task in a repo where Colony tools are available.
---

# Colony MCP

Use Colony as the coordination source of truth. Colony does not run agents; it
shows live branches, claims, handoffs, ready work, stale ownership, and compact
memory so agents avoid duplicate work.

## Startup

1. Call `hivemind_context` with `agent`, `session_id`, and `repo_root`.
2. Call `attention_inbox` before choosing or resuming work.
3. Call `task_ready_for_agent` to pick claimable plan work. Use `task_list`
   only for browsing or debugging, not as the scheduler.
4. If a pending handoff is relevant, call `task_accept_handoff` before editing.

If Colony MCP tools are unavailable, say so and continue with local git and
repo inspection. Do not invent Colony state.

## Before Edits

1. Work on the repo's agent branch or worktree policy.
2. Claim plan work with `task_plan_claim_subtask` when the task came from a
   Colony plan.
3. Claim each file before editing with `task_claim_file`.
4. Record a compact working note with `task_note_working`:
   `branch=<branch>; task=<task>; blocker=<blocker>; next=<next>; evidence=<evidence>`.

Claims are coordination warnings, not locks. If another fresh claim overlaps
your edit, read the latest task thread and avoid overwriting unrelated work.

## During Work

- Post decisions, blockers, failed approaches, and handoffs with `task_post`.
- Use `task_message` for directed coordination when available.
- Keep notes compact: branch, task, blocker, next step, evidence.
- Hydrate full observations only when compact IDs are not enough.

## Finish or Stop

Before stopping, run `git status` and identify dirty files.

- If work is complete: verify, commit, push, open or update the PR, and record
  PR URL plus verification evidence.
- If work is incomplete: hand it off with claimed files, dirty files, branch,
  last verification, blocker, and next step.
- If abandoning work: release or weaken claims so the next agent is not blocked
  by stale strong ownership.
