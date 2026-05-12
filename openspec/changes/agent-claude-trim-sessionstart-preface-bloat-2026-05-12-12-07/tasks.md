## Definition of Done

This change is complete only when **all** of the following are true:

- Every checkbox below is checked.
- The agent branch reaches `MERGED` state on `origin` and the PR URL + state are recorded in the completion handoff.
- If any step blocks (test failure, conflict, ambiguous result), append a `BLOCKED:` line under section 4 explaining the blocker and **STOP**.

## Handoff

- Handoff: change=`agent-claude-trim-sessionstart-preface-bloat-2026-05-12-12-07`; branch=`agent/claude/trim-sessionstart-preface-bloat-2026-05-12-12-07`; scope=`SessionStart preface contract trim`; action=`continue this sandbox or finish cleanup after a usage-limit/manual takeover`.

## 1. Specification

- [x] 1.1 Finalize proposal scope (`proposal.md`).
- [x] 1.2 Define normative requirements (`specs/trim-sessionstart-preface-bloat/spec.md`).

## 2. Implementation

- [ ] 2.1 Add `sessionStart.contractMode` field to `SettingsSchema` (`packages/config/src/schema.ts`).
- [ ] 2.2 Export `quotaSafeOperatingContractCompact` from `packages/config/src/instructions.ts`.
- [ ] 2.3 Have `buildQuotaSafeOperatingPreface` (`packages/hooks/src/handlers/session-start.ts`) dispatch on the new setting.
- [ ] 2.4 Update `packages/hooks/test/session-start.test.ts:170-209` to cover compact (default), full, none.
- [ ] 2.5 Update `README.md` references to the contract preface.
- [ ] 2.6 Add a changeset entry.

## 3. Verification

- [ ] 3.1 `pnpm --filter @colony/config test`.
- [ ] 3.2 `pnpm --filter @colony/hooks test`.
- [ ] 3.3 `openspec validate agent-claude-trim-sessionstart-preface-bloat-2026-05-12-12-07 --type change --strict`.
- [ ] 3.4 `openspec validate --specs`.

## 4. Cleanup

- [ ] 4.1 `gx branch finish --branch agent/claude/trim-sessionstart-preface-bloat-2026-05-12-12-07 --base main --via-pr --wait-for-merge --cleanup`.
- [ ] 4.2 Record PR URL and `MERGED` state in the handoff.
- [ ] 4.3 Confirm sandbox worktree is gone.
