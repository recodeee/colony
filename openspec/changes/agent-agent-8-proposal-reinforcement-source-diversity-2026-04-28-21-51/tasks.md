# Tasks

## 1. Scoring

- [x] Inspect `task_reinforce` and `ProposalSystem` scoring.
- [x] Collapse same-session duplicate reinforcement.
- [x] Add deterministic source-diversity weighting by session and agent type.
- [x] Make `rediscovered` stronger than `explicit`.
- [x] Preserve the existing MCP/API shape.

## 2. Tests

- [x] Add same-session duplicate spam coverage.
- [x] Add different-session strength coverage.
- [x] Add rediscovered different-agent bonus coverage.
- [x] Add promotion-threshold coverage under source-diverse scoring.

## 3. Docs

- [x] Document scoring in MCP docs.
- [x] Clarify storage schema comment for collapsed scoring.

## 4. Verification

- [x] `pnpm --filter @colony/core test -- proposal-system`
- [x] `pnpm --filter @colony/core test`
- [x] `pnpm --filter @colony/hooks test -- proposal-system`
- [x] `pnpm --filter @colony/core typecheck`
- [x] `pnpm --filter @colony/storage typecheck`
- [x] `pnpm exec biome check packages/core/src/proposal-system.ts packages/core/test/proposal-system.test.ts packages/storage/src/schema.ts docs/mcp.md`
- [x] `openspec validate --specs`
- [x] `openspec validate agent-agent-8-proposal-reinforcement-source-diversity-2026-04-28-21-51 --strict`

## 5. Completion

- [ ] Commit, push, PR, merge.
- [ ] Record final `MERGED` evidence and sandbox cleanup.
