---
name: co-build
description: Execute the next §T task on the current colonykit change. Use when the user runs `/co:build` or asks you to proceed with the next task. Pulls cite-scoped context, executes, on test failure records via backprop gating.
---

# /co:build

Execute the next pending task in the current change.

## Preconditions

- There must be an active change. If the user hasn't run `/co:change` yet, refuse and redirect them.
- Determine the active change: read `openspec/changes/*/CHANGE.md`; the one whose backing task-thread is newest + not archived is active. If multiple, ask which.

## Procedure

### 1. Find the next task

Read `CHANGE.md` §T. The next task is the first row with status `.` (todo).
If all are `x` (done) or `~` (wip-by-someone-else), stop — nothing to build.

### 2. Claim it

Call `task_claim_file` with `file_path = "CHANGE.md#T<n>"` so other agents on this spec thread see the claim. Overlapping claims surface in `attention_inbox` on their next turn.

### 3. Load cite-scoped context — DO NOT read the whole SPEC.md

Call `spec_build_context` with `repo_root` and `task_id = T<n>`.

The returned `rendered` field is your entire context for this task. §G + the task row + its cited §V/§I/§T rows + any §V.always invariants. Nothing else.

This is the point of cite-scoped loading. Reading the full spec defeats the token economy the §T cites column exists to enforce.

### 4. Lookahead — check for prior failures

Call `search` with the task row's text + cites as query. If hits include `BUG:` or `signature_hash` patterns, prepend a brief "prior failures on this pattern" note to your plan. Don't block — just surface.

### 5. Execute

Do the work. Edit files. Run tests.

### 6. On test failure — record via backprop

Call `spec_build_record_failure` with:
- `test_id`: the specific failing test (e.g. `packages/spec/test/sync.test.ts > three-way conflict`)
- `error`: the error class + message (first line of the failure)
- `stack`: the stack trace (for signature frame extraction)
- `error_summary`: one-line human summary

The tool returns an `action`:
- `append_only` — first occurrence; §B row appended, no invariant proposal. Retry the test.
- `propose_invariant` — threshold crossed; a draft §V was proposed via colony's ProposalSystem. Tell the user: "draft invariant proposed after N failures — will promote once confirmed."
- `promote_existing` — same signature as a prior failure; colony reinforced the existing proposal. Tell the user: "reinforced existing invariant proposal #N."

### 7. On success — mark `x`

Edit `CHANGE.md` §T, flip `.` → `x` for this task. Post a `task_post` with kind `decision`.

## Token budget

Per §V8 — ≤ 1 status line per phase unless `--verbose`.

Phases: claim, context-load, execute, verify, mark. Verbose mode shows each; default mode shows only the final result.

## Why this shape

The whole skill is designed so the agent never pulls more spec content than the current task cites. If the task row is `T5|.|rewrite skills/spec|V1,V2,§sync`, the agent sees §G + T5 + V1 + V2 + the §sync section + any §V.always — nothing else. This caps per-task context at a small fraction of the full SPEC.md.
