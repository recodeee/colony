# Tasks

## Implementation

- [x] Add GitGuardex availability and lane-status helpers.
- [x] Add `colony agents spawn --executor gx` with dry-run and real spawn paths.
- [x] Resolve Queen/task plan subtasks and map file scope to repeated `--claim` flags.
- [x] Sync successful gx starts back into Colony session/subtask/file claims.
- [x] Add `colony cockpit` with `gx cockpit --target <repo_root> --session colony-<repo-slug>`.
- [x] Show GitGuardex lanes in `colony status`.
- [x] Cover dry-run, unavailable gx, claim mapping, cockpit, duplicate-spawn refusal, claim sync, and status ingestion tests.

## Verification

- [x] `pnpm --filter @imdeadpool/colony-cli test` -> 22 files, 125 tests passed.
- [x] `pnpm typecheck` -> all workspace package typechecks passed.
- [x] `openspec validate --specs` -> 2 specs passed.
- [x] `COLONY_HOME=/tmp/colony-gx-verify node apps/cli/dist/index.js agents spawn --executor gx --dry-run` -> no ready subtasks, no spawn.
- [x] `COLONY_HOME=/tmp/colony-gx-verify node apps/cli/dist/index.js cockpit --dry-run` -> prints `gx cockpit --target ... --session colony-...`, no agent spawn.

## Completion / cleanup

- [x] Commit changes -> merged via PR #313 (`dfb106a1b12e3d763490df927d09fa2a2198e96d`); follow-on bridge surfaces merged via PR #316 (`cd66071002b54b58d459453ea730b547dae24ebd`) and PR #318 (`5f64a36cf5cac27ac4e5f51508e2ec586176a143`).
- [x] Push branch -> PR #313 head `agent/codex/show-gitguardex-lanes-health-status-2026-04-30-00-06` reached GitHub; follow-on heads `agent/codex/gitguardex-executor-spawn-bridge-2026-04-30-00-11` and `agent/codex/colony-cockpit-gitguardex-entrypoint-2026-04-30-00-11` also reached GitHub.
- [x] Open/update PR and record PR URL -> https://github.com/recodeee/colony/pull/313; related completion PRs: https://github.com/recodeee/colony/pull/316 and https://github.com/recodeee/colony/pull/318.
- [x] Verify PR state is `MERGED` -> `gh pr view 313 --json number,state,url,headRefName,baseRefName,mergeCommit,mergedAt` returned `state=MERGED`, `mergedAt=2026-04-29T22:57:31Z`, `mergeCommit=dfb106a1b12e3d763490df927d09fa2a2198e96d`.
- [x] Prune sandbox worktree and record cleanup evidence -> `git worktree list` on 2026-05-04 shows no `show-gitguardex-lanes-health-status-2026-04-30-00-06`, `gitguardex-executor-spawn-bridge-2026-04-30-00-11`, or `colony-cockpit-gitguardex-entrypoint-2026-04-30-00-11` worktrees remaining.
