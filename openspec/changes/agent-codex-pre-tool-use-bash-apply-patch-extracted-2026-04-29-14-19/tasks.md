# Tasks

- [x] Inspect Bash/apply_patch PreToolUse and shared extraction path.
- [x] Extract Bash redirect, sed/perl in-place, tee, and apply_patch targets before execution.
- [x] Filter pseudo paths and code fragments before claims.
- [x] Surface `extracted_paths` in PreToolUse hook results and lifecycle audit metadata.
- [x] Add focused parser, pre-hook, lifecycle, and contract tests.
- [x] Run targeted tests, typecheck, and OpenSpec validation.
  - `pnpm --filter @colony/hooks test -- test/bash-parser.test.ts test/auto-claim.test.ts test/lifecycle-envelope.test.ts test/claim-before-edit-full-path.test.ts` passed: 4 files, 83 tests.
  - `pnpm --filter @colony/hooks typecheck` passed.
  - `pnpm --filter @colony/contracts test -- test/lifecycle-schema.test.ts` passed: 10 tests.
  - `pnpm --filter @colony/contracts typecheck` passed.
  - `pnpm exec biome check packages/hooks/src/bash-parser.ts packages/hooks/src/handlers/pre-tool-use.ts packages/hooks/src/handlers/post-tool-use.ts packages/hooks/src/lifecycle-envelope.ts packages/hooks/src/runner.ts packages/hooks/src/types.ts packages/hooks/test/auto-claim.test.ts packages/hooks/test/bash-parser.test.ts packages/hooks/test/claim-before-edit-full-path.test.ts packages/contracts/src/index.ts packages/contracts/test/lifecycle-schema.test.ts` passed.
  - `openspec validate agent-codex-pre-tool-use-bash-apply-patch-extracted-2026-04-29-14-19 --strict` passed.
  - `openspec validate --specs` passed: 2 specs.
- [ ] Finish PR, merge, and sandbox cleanup; record PR URL and `MERGED` evidence.
  - BLOCKED: `gx branch finish --branch agent/codex/pre-tool-use-bash-apply-patch-extracted-2026-04-29-14-19 --base main --via-pr --wait-for-merge --cleanup` required escalated network access and automatic approval was rejected because the usage limit is exhausted until 7:05 PM. Resume by rerunning the same finish command from the primary checkout when approval is available.
