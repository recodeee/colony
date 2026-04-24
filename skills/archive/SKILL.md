---
name: co-archive
description: Validate, three-way-merge, and archive a colonykit change. Use when the user runs `/co:archive <slug>` or says the change is done. Atomic — either the archive and root-write both land, or neither does.
---

# /co:archive

Archive a completed change and merge its §S delta into the root SPEC.md.

## Preconditions

- All §T rows in the change's CHANGE.md must be status `x` (done). If not, refuse and list the remaining tasks.
- The colony MCP server must be running.

## Procedure

1. Verify completion: read `openspec/changes/<slug>/CHANGE.md` §T, confirm all rows are `x`.
2. Call `spec_archive` with:
   - `repo_root`, `slug`, `session_id`, `agent`
   - `strategy`: default `three_way`. Pass `last_writer_wins` only if the user explicitly accepted conflicts.
3. Handle the response:
   - `status: archived` — print `archived_path`, `applied` delta count, and any conflicts that were resolved.
   - `status: refused` — print the conflict list and tell the user to either resolve manually or re-run with `--strategy last_writer_wins`.

## Conflict handling

If the response includes non-empty `conflicts[]`:

- `root_modified_since_base` — root changed since `/co:change` opened. The safe move is to tell the user: someone else edited SPEC.md; re-open the change against the current root, or use `last_writer_wins` at your own risk.
- `delta_removes_cited_row` — the change removes a §V row that something else still cites. This is usually a mistake in the delta; advise editing the change rather than forcing the archive.
- `unknown_target` — the delta targets a section that doesn't accept deltas (e.g. `G.` or `C.`). Edit the change.

## Output

One line on success:
```
✓ archived add-dark-mode · 7 deltas applied · openspec/changes/archive/2026-04-24-add-dark-mode/
```

## Why atomic

`spec_archive` stages the archive move in a temp path, writes the new root, then atomically renames. A crash mid-call leaves either the pre-archive state or the fully-archived state. Don't build a "retry after partial archive" path — there is no partial archive.
