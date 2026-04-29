# Active Task Binding For Auto-Claim

## Problem

Codex and OMX hook events do not always carry the exact Colony session id that
already participates in a task. Auto-claim needs a canonical, non-guessing way
to bind those events back to the active Colony task before writing claim
telemetry.

## Change

- Resolve active tasks in explicit order: exact session id, repo root plus
  branch, cwd or worktree path, then a single unambiguous active task for the
  agent.
- Return structured binding states for `bound`, `ambiguous`, and `not_found`.
- Include compact candidate details for ambiguous results, including active
  files when local claims make them cheap to report.
- Keep not-found failures actionable with create/bind guidance and manual
  `task_claim_file` fallback text.

## Scope

Hook-side active task binding and pre-edit warning shape only. Colony remains
the canonical task/claim source of truth.
