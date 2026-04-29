## 1. Implementation

- [x] Inspect existing `rescue_stranded_scan` core path and coordination sweep cleanup semantics.
- [x] Add bulk stranded rescue core logic with read-only dry-run and explicit apply.
- [x] Add `colony rescue stranded --older-than <duration> --dry-run`.
- [x] Add `colony rescue stranded --older-than <duration> --apply`.
- [x] Keep audit observations intact and write `rescue-stranded` audit rows on apply.

## 2. Verification

- [x] Run focused core rescue tests: `pnpm --filter @colony/core test -- test/stranded-rescue.test.ts` (10 passed).
- [x] Run focused CLI rescue tests: `pnpm --filter @imdeadpool/colony-cli test -- test/rescue.test.ts test/program.test.ts` (13 passed).
- [x] Run CLI program registration test: covered by `apps/cli/test/program.test.ts` (11 passed).
- [x] Run focused lint/typecheck where practical: `pnpm exec biome check ...` passed; `pnpm --filter @colony/core typecheck` passed; `pnpm --filter @imdeadpool/colony-cli typecheck` blocked by unrelated `packages/hooks/src/handlers/pre-tool-use.ts` `resolution` field error in this worktree.

## 3. Completion

- [x] Commit branch.
- [ ] Push branch.
- [ ] Open/update PR.
- [ ] Merge PR.
- [ ] Confirm PR state `MERGED`.
- [ ] Confirm sandbox cleanup.
