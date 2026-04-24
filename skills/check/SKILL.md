---
name: co-check
description: Read-only drift check across root SPEC.md, the active change's delta, and the code. Use when the user runs `/co:check` or asks whether the spec and code are in sync. Writes nothing.
---

# /co:check

Read-only drift detection.

## Preconditions

- SPEC.md exists. Colony MCP server running.

## Procedure

1. Call `spec_read` — get rootHash and section shapes.
2. If there's an active change for this repo, call `attention_inbox` with the user's session id — surface pending handoffs, stalled lanes, and any recent claims by other sessions on `SPEC.md#V.*` or `CHANGE.md#*`.
3. Scan §T rows:
   - For any row cited as `x` (done), check that the cited files exist and the cited commands still succeed (run them with `--dry-run` where available).
   - For rows with status `~` (wip), list the session_id that claimed them via `task_list` + `task_timeline`.
4. Cross-change conflict surface (opt-in with `--cross-changes`):
   - List all spec lanes via `task_list` filtered on branch prefix `spec/`.
   - For each pair of in-flight changes, check whether both touch the same §V/§I/§T id. Report pairs that do.

## Output

A single report, no writes. Format:

```
SPEC.md  rootHash=abc12345
  §V  12 invariants (3 always-on)
  §T  18 tasks (11 done, 4 wip, 3 todo)
  §B  2 bugs

Active change: add-dark-mode (task #42)
  base_root_hash: abc12345 (in sync with root)
  deltas: 5 rows (3 add, 2 modify)

Attention:
  - codex@x7 claimed packages/spec/src/sync.ts 4m ago
  - 1 pending handoff to you from claude@a1

Cross-change (--cross-changes):
  none
```

## Why read-only is invariant

§V9 of the root spec makes this a hard rule. Never modify SPEC.md or any CHANGE.md from inside /co:check — even to fix a typo. If the user asks for fixes during a check, tell them to run `/co:spec` or edit the change.
