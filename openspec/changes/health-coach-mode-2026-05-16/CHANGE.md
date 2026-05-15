# Change: health coach mode

## Why

README §Roadmap → v0.x → "Adoption nudges" lists:

> ⏳ Adoption coach mode in `colony health` that walks a new repo through first-week setup

`colony health` today scores adoption against thresholds but does not _walk_
a new repo through the habits that produce the score. Result: a fresh
install sees a wall of green/yellow signals with no clear next action.

## What changes

Add `colony health --coach` — a first-week walkthrough that:

- Detects stage: `fresh` / `installed_no_signal` / `early` / `mid_adoption`,
  using cheap signals (`countObservations`, installed IDE flags,
  `firstObservationTs`, `Math.max(toolCallsSince, countMcpMetricsSince)` —
  Codex MCP traffic lands in `mcp_metrics` not `observations`).
- Surfaces the NEXT incomplete step from a fixed 7-step ladder
  (`install_runtime` → `first_task_post` → `first_task_claim_file` →
  `first_task_hand_off` → `first_plan_claim` → `first_quota_release` →
  `first_gain_review`). Each step carries `cmd:` and `tool:` strings so the
  reader has the exact next command.
- Persists progress in a new `coach_progress` SQLite table
  (`step_id PRIMARY KEY, completed_at, evidence`). Steps complete from
  observed events (`mcp_metrics` rows, `claimBeforeEditStats`, `colony gain`
  invocation observation), never from user click.
- Respects `--json` (returns `{ stage, completed_steps, next_step, upcoming }`).
- Mutually exclusive with `--fix-plan` — stderr warning, `--coach` wins.

## Surface

| Surface | Shape |
| --- | --- |
| CLI | `colony health --coach [--json]` |
| Storage | new table `coach_progress`, schema_version 13 → 14 |
| New methods | `markCoachStep(id, evidence)`, `listCoachSteps()`, `firstObservationTs()`, `countObservationsByKindSince(kind, since)` |
| New files | `apps/cli/src/commands/health-coach.ts`, `apps/cli/src/lib/installed-ides.ts`, `packages/storage/src/migrations/014-coach-progress.ts` |
| Side effect | `colony gain` records a `coach_gain_review` observation so step 7 can self-detect |

## Verification

- `pnpm --filter colonyq typecheck` — clean
- `pnpm typecheck` (monorepo) — clean
- `pnpm --filter colonyq test` — 293/293 pass (9 new health-coach tests)
- `pnpm --filter @colony/storage test` — 157/157 pass
- `biome check` on touched files — clean
- Manual smoke confirmed fresh + `--json` + `--coach --fix-plan` mutex
