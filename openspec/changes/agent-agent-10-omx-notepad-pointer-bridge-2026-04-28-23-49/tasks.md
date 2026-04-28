## 1. Implementation

- [x] Inspect existing `task_note_working`, settings schema, and notepad bridge tests.
- [x] Keep `bridge.writeOmxNotepadPointer` optional and default-off.
- [x] Ensure successful Colony working notes write only tiny OMX pointers when enabled.
- [x] Ensure no-active-task fallback writes a tiny OMX pointer only when explicitly allowed.
- [x] Cap pointer field length to avoid full logs/proofs in `.omx/notepad.md`.

## 2. Verification

- [x] Run focused MCP task-thread tests: `pnpm --filter @colony/mcp-server test -- task-threads.test.ts`.
- [x] Run config schema tests: `pnpm --filter @colony/config test -- schema.test.ts`.
- [x] Run focused typecheck: `pnpm --filter @colony/mcp-server typecheck`; `pnpm --filter @colony/config typecheck`.
- [x] Run OpenSpec validation: `openspec validate agent-agent-10-omx-notepad-pointer-bridge-2026-04-28-23-49 --type change --strict`.

## 3. Completion / Cleanup

- [ ] Commit changes.
- [ ] Push branch.
- [ ] Open/update PR.
- [ ] Record PR URL.
- [ ] Verify PR state is `MERGED`.
- [ ] Verify sandbox worktree cleanup.
