# Tasks

| # | Status | Title | Files | Depends on | Capability | Spec row | Owner |
| - | - | - | - | - | - | - | - |
0|completed|Update release metadata|`apps/cli/package.json`<br>`apps/cli/CHANGELOG.md`<br>`workspace package manifests/changelogs`<br>`README.md`<br>`.changeset`|-|doc_work|-|codex-app-release-bump-2026-05-08
1|completed|Verify publish readiness|`apps/cli/package.json`<br>`apps/cli/CHANGELOG.md`<br>`workspace package manifests/changelogs`<br>`README.md`<br>`.changeset`|0|doc_work|-|codex-app-release-bump-2026-05-08

## Evidence

- `npm view @imdeadpool/colony-cli version --json` -> `0.6.0`.
- `pnpm changeset version` -> bumped `@imdeadpool/colony-cli` and linked release packages to `0.7.0`.
- `pnpm run check:no-bridge-deps` -> passed.
- `pnpm --filter @imdeadpool/colony-cli typecheck` -> passed.
- `pnpm exec biome check .` -> passed.
- `openspec validate --specs` -> passed, `2 passed, 0 failed`.
- `pnpm publish:cli:dry-run` -> passed.
