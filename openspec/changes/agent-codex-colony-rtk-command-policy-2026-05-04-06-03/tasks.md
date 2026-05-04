# Tasks

- [x] Inspect generated Colony startup instruction source and installer/session-start coverage.
- [x] Add RTK command policy to generated quota-safe Colony operating contract.
- [x] Mirror the RTK command policy in repo `AGENTS.md` for current sessions.
- [x] Add focused regression coverage for generated SessionStart/installer contract text.
- [x] Run focused verification.
  - `command -v rtk` returned no path in this shell; raw commands were used with compact output.
  - `pnpm --filter @colony/hooks test -- test/session-start.test.ts` passed after `pnpm --filter @colony/storage rebuild better-sqlite3` restored the native SQLite binding.
  - `pnpm --filter @colony/installers test -- test/installers.test.ts` passed.
  - `pnpm --filter @colony/config typecheck` passed.
  - `pnpm --filter @colony/hooks typecheck` passed.
  - `pnpm --filter @colony/installers typecheck` passed.
  - `pnpm exec biome check AGENTS.md packages/config/src/instructions.ts packages/hooks/test/session-start.test.ts packages/installers/test/installers.test.ts openspec/changes/agent-codex-colony-rtk-command-policy-2026-05-04-06-03/tasks.md` passed.
  - `node --test test/agents-contract.test.js` passed.
  - `openspec validate --specs` passed.

## Cleanup

- [ ] Finish PR, merge, and sandbox cleanup; record PR URL and `MERGED` evidence.
