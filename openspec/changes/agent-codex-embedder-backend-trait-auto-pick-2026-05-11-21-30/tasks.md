## Definition of Done

This change is complete only when **all** of the following are true:

- Every checkbox below is checked.
- The agent branch reaches `MERGED` state on `origin` and the PR URL + state are recorded in the completion handoff.
- If any step blocks (test failure, conflict, ambiguous result), append a `BLOCKED:` line under section 4 explaining the blocker and **STOP**. Do not tick remaining cleanup boxes; do not silently skip the cleanup pipeline.

## Handoff

- Handoff: change=`agent-codex-embedder-backend-trait-auto-pick-2026-05-11-21-30`; branch=`agent/codex/embedder-backend-trait-auto-pick-2026-05-11-21-30`; scope=`batched embedding backfill`; action=`finish cleanup after verification`.
- Copy prompt: Continue `agent-codex-embedder-backend-trait-auto-pick-2026-05-11-21-30` on branch `agent/codex/embedder-backend-trait-auto-pick-2026-05-11-21-30`. Work inside the existing sandbox, review `openspec/changes/agent-codex-embedder-backend-trait-auto-pick-2026-05-11-21-30/tasks.md`, continue from the current state instead of creating a new sandbox, and when the work is done run `gx branch finish --branch agent/codex/embedder-backend-trait-auto-pick-2026-05-11-21-30 --base main --via-pr --wait-for-merge --cleanup`.

## 1. Specification

- [x] 1.1 Finalize proposal scope and acceptance criteria for `agent-codex-embedder-backend-trait-auto-pick-2026-05-11-21-30`.
- [x] 1.2 Define normative requirements in `specs/embedder-backend-trait-auto-pick/spec.md`.

## 2. Implementation

- [x] 2.1 Implement scoped behavior changes.
- [x] 2.2 Add/update focused regression coverage.

## 3. Verification

- [x] 3.1 Run targeted project verification commands.
- [x] 3.2 Run `openspec validate agent-codex-embedder-backend-trait-auto-pick-2026-05-11-21-30 --type change --strict`.
- [x] 3.3 Run `openspec validate --specs`.

## 4. Cleanup (mandatory; run before claiming completion)

- [ ] 4.1 Run the cleanup pipeline: `gx branch finish --branch agent/<your-name>/<branch-slug> --base dev --via-pr --wait-for-merge --cleanup`. This handles commit -> push -> PR create -> merge wait -> worktree prune in one invocation.
- [ ] 4.2 Record the PR URL and final merge state (`MERGED`) in the completion handoff.
- [ ] 4.3 Confirm the sandbox worktree is gone (`git worktree list` no longer shows the agent path; `git branch -a` shows no surviving local/remote refs for the branch).

BLOCKED: PR https://github.com/recodeee/colony/pull/519 is open with pending build checks; cleanup/merge is also blocked by unrelated local batch-embedding edits in this sandbox (`apps/worker/src/embed-loop.ts`, `apps/worker/test/embed-loop.test.ts`, `packages/config/src/schema.ts`, `packages/config/test/schema.test.ts`, `packages/core/src/memory-store.ts`, `packages/embedding/src/providers/codex-gpu.ts`, `packages/embedding/src/types.ts`, `packages/embedding/test/codex-gpu.test.ts`, `packages/storage/src/storage.ts`, `packages/storage/test/storage.test.ts`, `.changeset/reindex-batched-embed-loop.md`).
