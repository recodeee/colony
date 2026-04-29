# GitGuardex executor bridge

## Problem

Colony plans and ready subtasks need a Guardex-backed execution path so planning and coordination stay in Colony while GitGuardex owns isolated branches, worktrees, file locks, tmux cockpit launch, and PR-only finish flow.

## Scope

- Add a `gx` executor for `colony agents spawn`.
- Add `colony cockpit` as a cockpit entrypoint that does not launch agents implicitly.
- Surface GitGuardex lanes and claims in Colony status.
- Sync spawned subtask file scopes into both `gx agents start --claim` and Colony task claims.

## Verification

- `pnpm --filter @imdeadpool/colony-cli test`
- `pnpm typecheck`
- `colony agents spawn --executor gx --dry-run`
- `colony cockpit --dry-run`
