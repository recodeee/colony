## Definition of Done

This change is complete only when **all** of the following are true:

- Every checkbox below is checked.
- The agent branch reaches `MERGED` state on `origin` and the PR URL + state are recorded in the completion handoff.
- If any step blocks (test failure, conflict, ambiguous result), append a `BLOCKED:` line under section 4 explaining the blocker and **STOP**. Do not tick remaining cleanup boxes; do not silently skip the cleanup pipeline.

## Handoff

- Handoff: change=`agent-claude-fix-mcp-token-bloat-and-claim-ux-2026-05-13-23-48`; branch=`agent/<your-name>/<branch-slug>`; scope=`TODO`; action=`continue this sandbox or finish cleanup after a usage-limit/manual takeover`.
- Copy prompt: Continue `agent-claude-fix-mcp-token-bloat-and-claim-ux-2026-05-13-23-48` on branch `agent/<your-name>/<branch-slug>`. Work inside the existing sandbox, review `openspec/changes/agent-claude-fix-mcp-token-bloat-and-claim-ux-2026-05-13-23-48/tasks.md`, continue from the current state instead of creating a new sandbox, and when the work is done run `gx branch finish --branch agent/<your-name>/<branch-slug> --base dev --via-pr --wait-for-merge --cleanup`.

## 1. Specification

- [x] 1.1 Finalize proposal scope and acceptance criteria — see `proposal.md`.
- [x] 1.2 Define normative requirements in `specs/fix-mcp-token-bloat-and-claim-ux/spec.md`.

## 2. Implementation

- [x] 2.1 `task_plan_list`: add `detail: 'compact' | 'full'` (default compact); compact projection drops `subtasks[].description` and `subtasks[].file_scope` (`apps/mcp-server/src/tools/plan.ts`).
- [x] 2.2 `task_note_working`: attach `nearby_tasks` + recovery `hint` on `ACTIVE_TASK_NOT_FOUND` (`apps/mcp-server/src/tools/task.ts`).
- [x] 2.3 `task_plan_claim_subtask`: attach `next_available_subtask_index` + compact `next_available[]` on `PLAN_SUBTASK_NOT_AVAILABLE` (`apps/mcp-server/src/tools/plan.ts`).
- [x] 2.4 Update existing `task_plan_list` callers in tests to opt into `detail: 'full'` where they read full-shape subtasks.
- [x] 2.5 Add new regression tests for all three behaviors (`apps/mcp-server/test/plan.test.ts`, `apps/mcp-server/test/task-threads.test.ts`).

## 3. Verification

- [x] 3.1 `pnpm --filter @colony/mcp-server typecheck` green.
- [x] 3.2 `pnpm --filter @colony/mcp-server test` green (266 tests passing).
- [x] 3.3 `pnpm exec biome check` clean on touched files.

## 4. Cleanup (mandatory; run before claiming completion)

- [ ] 4.1 Run the cleanup pipeline: `gx branch finish --branch agent/<your-name>/<branch-slug> --base dev --via-pr --wait-for-merge --cleanup`. This handles commit -> push -> PR create -> merge wait -> worktree prune in one invocation.
- [ ] 4.2 Record the PR URL and final merge state (`MERGED`) in the completion handoff.
- [ ] 4.3 Confirm the sandbox worktree is gone (`git worktree list` no longer shows the agent path; `git branch -a` shows no surviving local/remote refs for the branch).
