## Definition of Done

This change is complete only when **all** of the following are true:

- Every checkbox below is checked.
- The agent branch reaches `MERGED` state on `origin` and the PR URL + state are recorded in the completion handoff.
- If any step blocks (test failure, conflict, ambiguous result), append a `BLOCKED:` line under section 4 explaining the blocker and **STOP**. Do not tick remaining cleanup boxes; do not silently skip the cleanup pipeline.

## Handoff

- Handoff: change=`agent-codex-batched-ingest-pipeline-2026-05-11-21-30`; branch=`agent/codex/batched-ingest-pipeline-2026-05-11-21-30`; scope=`worker embed batching + embedder batch API`; action=`continue this sandbox or finish cleanup after a usage-limit/manual takeover`.
- Copy prompt: Continue `agent-codex-batched-ingest-pipeline-2026-05-11-21-30` on branch `agent/codex/batched-ingest-pipeline-2026-05-11-21-30`. Work inside the existing sandbox, review `openspec/changes/agent-codex-batched-ingest-pipeline-2026-05-11-21-30/tasks.md`, continue from the current state instead of creating a new sandbox, and when the work is done run `gx branch finish --branch agent/codex/batched-ingest-pipeline-2026-05-11-21-30 --base main --via-pr --wait-for-merge --cleanup`.

## 1. Specification

- [x] 1.1 Finalize proposal scope and acceptance criteria for `agent-codex-batched-ingest-pipeline-2026-05-11-21-30`.
- [x] 1.2 Define normative requirements in `specs/batched-ingest-pipeline/spec.md`.

## 2. Implementation

- [x] 2.1 Implement scoped behavior changes.
- [x] 2.2 Add/update focused regression coverage.
  - Prompt 5 follow-up: `IngestBatcher` flushes now split by hardcoded token-estimate buckets and merge only tiny immediately adjacent buckets with capacity.

## 3. Verification

- [x] 3.1 Run targeted project verification commands.
  - Prompt 5 evidence: `pnpm --filter @colony/worker test -- embed-loop` passed with 9 tests, including `31×short + 1×long` padding-work regression >3x and adjacent tiny-bucket merge coverage.
  - Prompt 5 evidence: `pnpm --filter @colony/worker typecheck` passed.
- [x] 3.2 Run `openspec validate agent-codex-batched-ingest-pipeline-2026-05-11-21-30 --type change --strict`.
- [x] 3.3 Run `openspec validate --specs`.

## 4. Cleanup (mandatory; run before claiming completion)

- [ ] 4.1 Run the cleanup pipeline: `gx branch finish --branch agent/codex/batched-ingest-pipeline-2026-05-11-21-30 --base main --via-pr --wait-for-merge --cleanup`. This handles commit -> push -> PR create -> merge wait -> worktree prune in one invocation.
- [ ] 4.2 Record the PR URL and final merge state (`MERGED`) in the completion handoff.
- [ ] 4.3 Confirm the sandbox worktree is gone (`git worktree list` no longer shows the agent path; `git branch -a` shows no surviving local/remote refs for the branch).
