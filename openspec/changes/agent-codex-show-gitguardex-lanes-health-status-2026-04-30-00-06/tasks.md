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

- BLOCKED: `git add` could not create `.git/worktrees/colony__codex__show-gitguardex-lanes-health-status-2026-04-30-00-06/index.lock` in the sandbox, and escalated git index write was rejected by approval quota until 4:55 AM. Next: rerun verification after reconstruction, then `git add`, commit, push, PR/merge, and prune the worktree.
- [ ] Commit changes.
- [ ] Push branch.
- [ ] Open/update PR and record PR URL.
- [ ] Verify PR state is `MERGED`.
- [ ] Prune sandbox worktree and record cleanup evidence.
