# CocoIndex Session Token Source

## Problem

Codex and Claude sessions already store compressed observations and token receipt metadata, but there is no CocoIndex-friendly source that can incrementally index compact session context without replaying full observations into agent prompts.

## Change

- Add a core builder for compact Codex/Claude session records with token savings totals.
- Add `colony cocoindex sessions --out <dir>` to write one JSON source file per session.
- Write an optional `colony_cocoindex_sessions.py` app that CocoIndex can update incrementally into compact Markdown cards.

## Acceptance

- Codex and Claude sessions are exported by default; other IDEs are filtered out.
- Token receipt totals and compact token counts are included per session.
- Generated CocoIndex app uses file-level memoized processing so changed sessions can be reprocessed independently.

## Verification

- `pnpm --filter @colony/core test -- cocoindex-session-source`: 2 passed.
- `pnpm --filter @imdeadpool/colony-cli test -- cocoindex`: 2 passed.
- `pnpm exec biome check packages/core/src/cocoindex-session-source.ts packages/core/test/cocoindex-session-source.test.ts apps/cli/src/commands/cocoindex.ts apps/cli/src/index.ts apps/cli/test/cocoindex.test.ts`: passed.
- `pnpm --filter @colony/core typecheck`: blocked by existing linked-worktree dependency resolution for `better-sqlite3`.
- `pnpm --filter @imdeadpool/colony-cli typecheck`: blocked by existing linked-worktree dependency resolution for `commander`, MCP SDK, Hono, and `better-sqlite3`.
