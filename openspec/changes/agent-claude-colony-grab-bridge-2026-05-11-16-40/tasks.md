## Definition of Done

This change is complete only when **all** of the following are true:

- Every checkbox below is checked.
- The agent branch reaches `MERGED` state on `origin` and the PR URL + state are recorded in the completion handoff.
- If any step blocks (test failure, conflict, ambiguous result), append a `BLOCKED:` line under section 4 explaining the blocker and **STOP**. Do not tick remaining cleanup boxes; do not silently skip the cleanup pipeline.

## Handoff

- Handoff: change=`agent-claude-colony-grab-bridge-2026-05-11-16-40`; branch=`agent/<your-name>/<branch-slug>`; scope=`TODO`; action=`continue this sandbox or finish cleanup after a usage-limit/manual takeover`.
- Copy prompt: Continue `agent-claude-colony-grab-bridge-2026-05-11-16-40` on branch `agent/<your-name>/<branch-slug>`. Work inside the existing sandbox, review `openspec/changes/agent-claude-colony-grab-bridge-2026-05-11-16-40/tasks.md`, continue from the current state instead of creating a new sandbox, and when the work is done run `gx branch finish --branch agent/<your-name>/<branch-slug> --base dev --via-pr --wait-for-merge --cleanup`.

## 1. Specification

- [x] 1.1 Finalize proposal scope and acceptance criteria for `agent-claude-colony-grab-bridge-2026-05-11-16-40`.
- [x] 1.2 Define normative requirements in `specs/colony-grab-bridge/spec.md`.

## 2. Implementation

- [x] 2.1 Add `colony grab` command group (`serve`, `attach`, `status`) under `apps/cli/src/commands/grab.ts` with module under `apps/cli/src/lib/grab/`.
- [x] 2.2 Register the command in `apps/cli/src/index.ts`.
- [x] 2.3 Add request-gating tests (`apps/cli/test/grab-server.test.ts`) covering Content-Type / Origin / Authorization / body rejections and dedup path.
- [x] 2.4 Add changeset (`.changeset/colony-grab-bridge.md`).

## 3. Verification

- [x] 3.1 `pnpm --filter colonyq typecheck` green.
- [x] 3.2 `pnpm --filter colonyq test -- grab-server` 12/12 passing.
- [x] 3.3 `pnpm --filter colonyq test -- program` snapshot updated.
- [x] 3.4 Biome check clean on all new files.
- [x] 3.5 `openspec validate agent-claude-colony-grab-bridge-2026-05-11-16-40 --type change --strict` green.
- [ ] 3.6 `pnpm test` (full repo) green.
- [ ] 3.7 `pnpm build` green.

## 4. Cleanup (mandatory; run before claiming completion)

- [ ] 4.1 Run the cleanup pipeline: `gx branch finish --branch agent/<your-name>/<branch-slug> --base dev --via-pr --wait-for-merge --cleanup`. This handles commit -> push -> PR create -> merge wait -> worktree prune in one invocation.
- [ ] 4.2 Record the PR URL and final merge state (`MERGED`) in the completion handoff.
- [ ] 4.3 Confirm the sandbox worktree is gone (`git worktree list` no longer shows the agent path; `git branch -a` shows no surviving local/remote refs for the branch).
