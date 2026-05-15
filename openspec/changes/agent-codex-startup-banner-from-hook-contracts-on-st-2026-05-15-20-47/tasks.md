## Definition of Done

This change is complete only when **all** of the following are true:

- Every checkbox below is checked.
- The agent branch reaches `MERGED` state on `origin` and the PR URL + state are recorded in the completion handoff.
- If any step blocks (test failure, conflict, ambiguous result), append a `BLOCKED:` line under section 4 explaining the blocker and **STOP**. Do not tick remaining cleanup boxes; do not silently skip the cleanup pipeline.

## Handoff

- Handoff: change=`agent-codex-startup-banner-from-hook-contracts-on-st-2026-05-15-20-47`; branch=`agent/codex/startup-banner-from-hook-contracts-on-st-2026-05-15-20-47`; scope=`packages/hooks/src/lifecycle-envelope.ts`; action=`finish verification and cleanup`.
- Copy prompt: Continue `agent-codex-startup-banner-from-hook-contracts-on-st-2026-05-15-20-47` on branch `agent/codex/startup-banner-from-hook-contracts-on-st-2026-05-15-20-47`. Work inside the existing sandbox, review `openspec/changes/agent-codex-startup-banner-from-hook-contracts-on-st-2026-05-15-20-47/tasks.md`, continue from the current state instead of creating a new sandbox, and when the work is done run `gx branch finish --branch agent/codex/startup-banner-from-hook-contracts-on-st-2026-05-15-20-47 --base dev --via-pr --cleanup`.

## 1. Specification

- [x] 1.1 Finalize proposal scope and acceptance criteria for `agent-codex-startup-banner-from-hook-contracts-on-st-2026-05-15-20-47`.
- [x] 1.2 Define normative requirements in `specs/startup-banner-from-hook-contracts-on-stalled-lane/spec.md`.

## 2. Implementation

- [x] 2.1 Implement scoped behavior changes.
- [x] 2.2 Add/update focused regression coverage.

## 3. Verification

- [x] 3.1 Run targeted project verification commands.
  - `pnpm --filter @colony/hooks test -- lifecycle-envelope.test.ts session-start.test.ts`
  - `pnpm --filter @colony/hooks typecheck`
  - `pnpm --filter @colony/hooks build`
  - `git diff --check`
- [x] 3.2 Run `openspec validate agent-codex-startup-banner-from-hook-contracts-on-st-2026-05-15-20-47 --type change --strict`.
- [x] 3.3 Run `openspec validate --specs`.

## 4. Cleanup (mandatory; run before claiming completion)

- [ ] 4.1 Run the cleanup pipeline: `gx branch finish --branch agent/<your-name>/<branch-slug> --base dev --via-pr --wait-for-merge --cleanup`. This handles commit -> push -> PR create -> merge wait -> worktree prune in one invocation.
- [ ] 4.2 Record the PR URL and final merge state (`MERGED`) in the completion handoff.
- [ ] 4.3 Confirm the sandbox worktree is gone (`git worktree list` no longer shows the agent path; `git branch -a` shows no surviving local/remote refs for the branch).
