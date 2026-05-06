# Improve Agent Load Shedding

## Problem

Starting or resuming many agents can create burst work even when each hook is individually small. SessionStart can detach-spawn repeated foraging scans, and each MCP tool call can rescan active-session sidecars.

## Change

- Coalesce automatic SessionStart foraging scans per cwd with a configurable cooldown.
- Throttle MCP active-session reconciliation scans inside each MCP server process.
- Keep both controls configurable and allow `0` to restore eager behavior.

## Acceptance

- Bursty SessionStart hooks for the same cwd start at most one automatic foraging scan inside the cooldown window.
- MCP tool calls still refresh the caller heartbeat but avoid rescanning all active-session sidecars until the reconciliation cooldown expires.
- Tests cover default config values and both load-shedding paths.

## Verification

- `pnpm --filter @colony/config test -- schema.test.ts`: 7 passed.
- `pnpm --filter @colony/hooks test -- session-start.test.ts`: 13 passed.
- `pnpm --filter @colony/mcp-server test -- server.test.ts`: 22 passed.
- `pnpm exec biome check packages/config/src/schema.ts packages/config/test/schema.test.ts packages/hooks/src/handlers/session-start.ts packages/hooks/test/session-start.test.ts apps/mcp-server/src/tools/heartbeat.ts apps/mcp-server/src/server.ts apps/mcp-server/test/server.test.ts`: passed.
- `pnpm --filter @colony/config typecheck`: passed.
- `pnpm --filter @colony/hooks typecheck`: blocked by existing missing `better-sqlite3` declaration in `packages/storage/src/storage.ts`.
- `pnpm --filter @colony/mcp-server typecheck`: blocked by the same existing missing `better-sqlite3` declaration.
- `openspec validate --specs`: 2 passed, 0 failed.
