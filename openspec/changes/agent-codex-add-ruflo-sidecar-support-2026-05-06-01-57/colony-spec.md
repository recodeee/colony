# Optional Ruflo Sidecar CLI

## Problem

Operators want to run Ruflo beside Colony without vendoring Ruflo code or making
Colony depend on a separate runtime.

## Contract

- `colony sidecar ruflo init` creates an optional local `ruflo-sidecar/`
  scaffold.
- `colony sidecar ruflo status` reports whether the scaffold config and event
  stream are present.
- `colony sidecar ruflo schema --json` exposes the compact `RufloBridgeEvent`
  contract already owned by `@colony/core`.
- Colony remains usable when the sidecar is absent.
- Ruflo sidecar output is advisory input; Colony remains the source of truth for
  claims, handoffs, task threads, health, and memory.

## Verification

- `pnpm --filter @imdeadpool/colony-cli test -- sidecar.test.ts program.test.ts`: 18 passed.
- `pnpm --filter @imdeadpool/colony-cli typecheck`: passed.
- `pnpm exec biome check --write apps/cli/src/commands/sidecar.ts apps/cli/test/sidecar.test.ts apps/cli/src/index.ts apps/cli/test/program.test.ts README.md docs/ruflo-sidecar.md`: passed.
- `pnpm --filter @imdeadpool/colony-cli build`: passed.
- `openspec validate --specs`: 2 passed.
- `git diff --check`: passed.
- `node apps/cli/dist/index.js sidecar ruflo schema --json`
- `node apps/cli/dist/index.js sidecar ruflo init --dir /tmp/colony-ruflo-sidecar-smoke-20260507-1126 --json`: created scaffold.
- `node apps/cli/dist/index.js sidecar ruflo status --dir /tmp/colony-ruflo-sidecar-smoke-20260507-1126 --json`: reported `ready: true`.
