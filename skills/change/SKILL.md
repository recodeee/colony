---
name: co-change
description: Open a new colonykit spec change. Use when the user runs `/co:change <slug>` or asks to start a new proposal, delta, or change-in-flight. Creates openspec/changes/<slug>/CHANGE.md and opens a task-thread on spec/<slug>.
---

# /co:change

Open a new spec change for the current repo.

## Preconditions

- SPEC.md must exist at the repo root. If missing, tell the user to run `colony spec init` first.
- The colony MCP server must be running. Verify via the presence of the `spec_change_open` tool.

## Procedure

1. Infer the repo root from the current working directory (walk up until you find `.git/`).
2. Derive the slug:
   - If the user passed one, use it verbatim.
   - Else generate a kebab-case slug from the user's description (≤ 40 chars, `[a-z0-9-]+`).
3. Call `spec_change_open` with:
   - `repo_root`: absolute path to repo root
   - `slug`: the derived slug
   - `session_id`: your current session id
   - `agent`: your agent name (`claude` or `codex`)
   - `proposal`: a one-paragraph proposal if the user gave context, else empty
4. If the user passed `--design`, also call the filesystem to create `openspec/changes/<slug>/design.md` with a template (motivation / trade-offs / alternatives).
5. Report back only:
   - `task_id` (for later `task_*` tool calls)
   - `path` (so the user can edit CHANGE.md directly)

## Output discipline

Per §V8 of SPEC.md — one status line. The user doesn't want narration; they want the path.

```
✓ change add-dark-mode opened · openspec/changes/add-dark-mode/CHANGE.md · task #42
```

## Failure modes

- `spec_change_open` returns isError when SPEC.md is missing. Surface the error verbatim and stop.
- If the task-thread already exists for this slug, the call is idempotent; report the existing task_id rather than failing.
