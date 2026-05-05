---
"@imdeadpool/colony-cli": minor
---

Self-healing coordination: periodic claim sweep + protected-branch guard.

Two architectural fixes that close the loop on the recurring "execution_safety / signal_evaporation" red flags in `colony health`:

**Auto-sweep loop (`apps/worker/src/coordination-sweep-loop.ts`).** The worker now runs `buildCoordinationSweep({ release_safe_stale_claims: true, release_expired_quota_claims: true })` every `coordinationSweepIntervalMinutes` (default 60). The infrastructure already existed — `Storage.sweepStaleClaims` and `releaseSafeStaleClaims` — but had no automatic trigger, so orphaned claims from sessions that exited without releasing piled up indefinitely (the user just had to release **159** of them at once via a manual sweep). Set the setting to 0 to disable.

**Protected-branch claim guard (`packages/core/src/scoped-claim.ts`).** `task_claim_file` now rejects claims targeting tasks bound to protected base branches (`main` / `master` / `dev` / `develop` / `production` / `release`) with a new `protected_branch_rejected` status, instead of recording them with a soft warning. This is what stops the dashboard's "claims on protected branches: 2" from reappearing within an hour of every cleanup. The new `rejectProtectedBranchClaims` setting (default true) toggles the behavior; the existing soft-warn path stays available via `rejectProtectedBranchClaims: false` or per-call `COLONY_ALLOW_PROTECTED_CLAIM=1`.

Also fixes a follow-up regression from PR #444: lowercase `-v` canonicalization is moved from the bin entrypoint into `createProgram().parseAsync` so tests calling `program.parseAsync(['node', 'test', '-v'])` directly hit the same flag-rewrite path. Updates the matching `--help` snapshot.

Tests:

- `packages/core/test/scoped-claim.test.ts` — rejection by default; legacy `rejectProtectedBranchClaims: false`; `COLONY_ALLOW_PROTECTED_CLAIM=1` override
- Existing `apps/mcp-server/test/task-threads.test.ts` opts into the legacy soft-warn behavior since those tests verify contention semantics, not branch policy
- One outdated `auto-claim` fixture moved off `branch: 'main'` to a canonical `agent/codex/...` branch for the same reason
