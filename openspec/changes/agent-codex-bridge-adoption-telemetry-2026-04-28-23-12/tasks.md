# Tasks

- [x] Inspect telemetry, debrief, status, and existing health/adoption code.
- [x] Add bridge/adoption metric calculation over local tool telemetry.
- [x] Surface bridge adoption metrics in `colony debrief` text and JSON.
- [x] Add focused tests for metric calculation and debrief JSON output.
- [x] Run targeted verification.
- [x] Commit, push, open PR, merge, and cleanup sandbox worktree.

## Completion Evidence

- Tests: `pnpm --filter @imdeadpool/colony-cli test`
- Typecheck: `pnpm --filter @imdeadpool/colony-cli typecheck`
- Lint/format: `pnpm exec biome check apps/cli/src/bridge-adoption.ts apps/cli/src/commands/debrief.ts apps/cli/test/bridge-adoption.test.ts apps/cli/test/debrief.test.ts apps/cli/test/program.test.ts`
- Build: `pnpm --filter @imdeadpool/colony-cli build`
- Smoke: `node apps/cli/dist/index.js debrief --json --hours 1` emitted `bridge_adoption`
- OpenSpec: `openspec validate agent-codex-bridge-adoption-telemetry-2026-04-28-23-12 --strict`
- PR URL: https://github.com/recodeee/colony/pull/188 (code/spec changes); https://github.com/recodeee/colony/pull/189 was an empty duplicate finish retry.
- Merge state: MERGED; PR #188 merged at 2026-04-28T21:23:20Z with merge commit 3f94aef4a3b3a91cae4560b43a0dc16c8ea222d7; PR #189 merged at 2026-04-28T21:24:33Z with empty merge commit d9f58be06d09c17fa44c8380ec9a99ad99a0db68.
- Sandbox cleanup: source worktree pruned; local and remote branch `agent/codex/bridge-adoption-telemetry-2026-04-28-23-12` deleted; `git worktree list` no longer shows the source worktree.
