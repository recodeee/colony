# Tasks

- [x] Inspect telemetry, debrief, status, and existing health/adoption code.
- [x] Add bridge/adoption metric calculation over local tool telemetry.
- [x] Surface bridge adoption metrics in `colony debrief` text and JSON.
- [x] Add focused tests for metric calculation and debrief JSON output.
- [x] Run targeted verification.
- [ ] Commit, push, open PR, merge, and cleanup sandbox worktree.

## Completion Evidence

- Tests: `pnpm --filter @imdeadpool/colony-cli test`
- Typecheck: `pnpm --filter @imdeadpool/colony-cli typecheck`
- Lint/format: `pnpm exec biome check apps/cli/src/bridge-adoption.ts apps/cli/src/commands/debrief.ts apps/cli/test/bridge-adoption.test.ts apps/cli/test/debrief.test.ts`
- Build: `pnpm --filter @imdeadpool/colony-cli build`
- Smoke: `node apps/cli/dist/index.js debrief --json --hours 1` emitted `bridge_adoption`
- OpenSpec: `openspec validate agent-codex-bridge-adoption-telemetry-2026-04-28-23-12 --strict`
- PR URL: pending
- Merge state: pending
- Sandbox cleanup: pending
