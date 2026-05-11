## Definition of Done

This change is complete only when **all** of the following are true:

- Every checkbox below is checked.
- The agent branch reaches `MERGED` state on `origin` and the PR URL + state are recorded in the completion handoff.
- If any step blocks (test failure, conflict, ambiguous result), append a `BLOCKED:` line under section 4 explaining the blocker and **STOP**. Do not tick remaining cleanup boxes; do not silently skip the cleanup pipeline.

## Handoff

- Handoff: change=`agent-codex-fix-colony-ready-work-accuracy-2026-05-11-23-11`; branch=`agent/codex/fix-colony-ready-work-accuracy-2026-05-11-23-11`; scope=`MCP/Core rescue requeues stale Queen plan subtasks`; action=`continue this sandbox or finish cleanup after a usage-limit/manual takeover`.
- Copy prompt: Continue `agent-codex-fix-colony-ready-work-accuracy-2026-05-11-23-11` on branch `agent/codex/fix-colony-ready-work-accuracy-2026-05-11-23-11`. Work inside the existing sandbox, review `openspec/changes/agent-codex-fix-colony-ready-work-accuracy-2026-05-11-23-11/tasks.md`, continue from the current state instead of creating a new sandbox, and when the work is done run `gx branch finish --branch agent/codex/fix-colony-ready-work-accuracy-2026-05-11-23-11 --base main --via-pr --wait-for-merge --cleanup`.

## 1. Specification

- [x] 1.1 Finalize proposal scope and acceptance criteria for `agent-codex-fix-colony-ready-work-accuracy-2026-05-11-23-11`.
- [x] 1.2 Define normative requirements in `specs/fix-colony-ready-work-accuracy/spec.md`.

## 2. Implementation

- [x] 2.1 Implement scoped behavior changes.
- [x] 2.2 Add/update focused regression coverage.

## 3. Verification

- [x] 3.1 Run targeted project verification commands.
  - `rtk test pnpm --filter @colony/core test -- stranded-rescue` -> 11 passed
  - `rtk test pnpm --filter @colony/mcp-server test -- rescue` -> 3 passed
  - `rtk test pnpm --filter @colony/mcp-server test -- ready-queue` -> 36 passed
  - `rtk test pnpm --filter @colony/core typecheck` -> passed
  - `rtk test pnpm --filter @colony/mcp-server typecheck` -> passed
- [x] 3.2 Run `openspec validate agent-codex-fix-colony-ready-work-accuracy-2026-05-11-23-11 --type change --strict`.
  - passed after tightening requirement wording to include `SHALL`
- [x] 3.3 Run `openspec validate --specs`.
  - passed, 2 specs valid

## 4. Cleanup (mandatory; run before claiming completion)

- [ ] 4.1 Run the cleanup pipeline: `gx branch finish --branch agent/<your-name>/<branch-slug> --base dev --via-pr --wait-for-merge --cleanup`. This handles commit -> push -> PR create -> merge wait -> worktree prune in one invocation.
- [ ] 4.2 Record the PR URL and final merge state (`MERGED`) in the completion handoff.
- [ ] 4.3 Confirm the sandbox worktree is gone (`git worktree list` no longer shows the agent path; `git branch -a` shows no surviving local/remote refs for the branch).
