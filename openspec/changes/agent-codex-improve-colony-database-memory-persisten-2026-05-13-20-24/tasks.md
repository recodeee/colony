## Definition of Done

This change is complete only when **all** of the following are true:

- Every checkbox below is checked.
- The agent branch reaches `MERGED` state on `origin` and the PR URL + state are recorded in the completion handoff.
- If any step blocks (test failure, conflict, ambiguous result), append a `BLOCKED:` line under section 4 explaining the blocker and **STOP**. Do not tick remaining cleanup boxes; do not silently skip the cleanup pipeline.

## Handoff

- Handoff: change=`agent-codex-improve-colony-database-memory-persisten-2026-05-13-20-24`; branch=`agent/codex/improve-colony-database-memory-persisten-2026-05-13-20-24`; scope=`storage schema indexes and memory write redaction guard`; action=`continue this sandbox or finish cleanup after a usage-limit/manual takeover`.
- Copy prompt: Continue `agent-codex-improve-colony-database-memory-persisten-2026-05-13-20-24` on branch `agent/codex/improve-colony-database-memory-persisten-2026-05-13-20-24`. Work inside the existing sandbox, review `openspec/changes/agent-codex-improve-colony-database-memory-persisten-2026-05-13-20-24/tasks.md`, continue from the current state instead of creating a new sandbox, and when the work is done run `gx branch finish --branch agent/codex/improve-colony-database-memory-persisten-2026-05-13-20-24 --base main --via-pr --wait-for-merge --cleanup`.

## 1. Specification

- [x] 1.1 Finalize proposal scope and acceptance criteria for `agent-codex-improve-colony-database-memory-persisten-2026-05-13-20-24`.
- [x] 1.2 Define normative requirements in `specs/improve-colony-database-memory-persistence/spec.md`.

## 2. Implementation

- [x] 2.1 Implement scoped behavior changes. Evidence: `packages/core/src/memory-store.ts`, `packages/storage/src/schema.ts`.
- [x] 2.2 Add/update focused regression coverage. Evidence: `packages/core/test/memory-store-token-receipts.test.ts`, `packages/storage/test/storage.test.ts`.

## 3. Verification

- [x] 3.1 Run targeted project verification commands. Evidence: `pnpm --filter @colony/core test -- memory-store-token-receipts.test.ts`, `pnpm --filter @colony/storage test -- storage.test.ts`, `pnpm --filter @colony/core typecheck`, `pnpm --filter @colony/storage typecheck`.
- [x] 3.2 Run `openspec validate agent-codex-improve-colony-database-memory-persisten-2026-05-13-20-24 --type change --strict`. Evidence: valid.
- [x] 3.3 Run `openspec validate --specs`. Evidence: 2 passed, 0 failed.

## 4. Cleanup (mandatory; run before claiming completion)

- [ ] 4.1 Run the cleanup pipeline: `gx branch finish --branch agent/codex/improve-colony-database-memory-persisten-2026-05-13-20-24 --base main --via-pr --wait-for-merge --cleanup`. This handles commit -> push -> PR create -> merge wait -> worktree prune in one invocation.
- [ ] 4.2 Record the PR URL and final merge state (`MERGED`) in the completion handoff.
- [ ] 4.3 Confirm the sandbox worktree is gone (`git worktree list` no longer shows the agent path; `git branch -a` shows no surviving local/remote refs for the branch).
