# Tasks

## 1. Implementation

- [x] Extend runtime summary health stats with claim-before-edit lifecycle counters.
- [x] Join fresh runtime summary lifecycle counters into `task_claim_file_before_edits`.
- [x] Add `lifecycle_summary_not_joined` for fresh summaries with edit paths but no ordered lifecycle event evidence.

## 2. Regression Coverage

- [x] Cover ordered PreToolUse/PostToolUse runtime summary events with zero storage claim stats.
- [x] Cover fresh `recent_edit_paths` with zero storage claim stats and no lifecycle event evidence.

## 3. Verification

- [x] `pnpm --filter @imdeadpool/colony-cli test -- health health-next-fixes`
- [x] `pnpm --filter @colony/core test -- omx-runtime-summary`
- [x] `pnpm --filter @colony/hooks test -- codex-omx-pretool`
- [x] `pnpm smoke:codex-omx-pretool`
- [x] `openspec validate --specs`
- [x] `pnpm --filter @colony/core build`
- [x] `pnpm --filter @imdeadpool/colony-cli build`
- [x] `node apps/cli/dist/index.js health --hours 1 --repo-root /home/deadpool/Documents/recodee/colony --json | jq '.omx_runtime_bridge.status, .omx_runtime_bridge.claim_before_edit, .task_claim_file_before_edits'`

## 4. Completion / Cleanup

- [x] Commit changes: `aa6984f`.
- [x] Open/update PR: https://github.com/recodeee/colony/pull/369.
- [x] Verify PR state `MERGED`: merge commit `6b707b959b77e293cf865f27899e46b78399b6ae`.
- [x] Verify sandbox worktree cleanup: `git worktree list` no longer includes `colony__codex__health-runtime-summary-claim-telemetry-2026-05-02-14-39`.
