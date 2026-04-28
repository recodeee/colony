# Tasks

- [x] Inspect MCP tool registration and CLI status/debrief bridge-adoption code.
- [x] Add compact `bridge_status` MCP tool and ready-work helper reuse.
- [x] Add focused active-session fixture coverage for compact bridge output.
- [x] Update MCP, README, and OpenSpec docs.
- [x] Run targeted verification.
- [ ] Commit, push, open PR, merge, and cleanup sandbox worktree.

## Completion Evidence

- Tests: `pnpm --filter @colony/mcp-server test` (124 passed)
- Typecheck: `pnpm --filter @colony/mcp-server typecheck`
- Lint/format: `pnpm exec biome check apps/mcp-server/src/server.ts apps/mcp-server/src/tools/bridge.ts apps/mcp-server/src/tools/ready-queue.ts apps/mcp-server/src/tools/task.ts apps/mcp-server/test/bridge-status.test.ts apps/mcp-server/test/server.test.ts apps/mcp-server/test/tool-descriptions.test.ts apps/mcp-server/test/coordination-loop.test.ts`
- Build: `pnpm --filter @colony/mcp-server build`
- OpenSpec: `openspec validate agent-agent9-omx-bridge-status-2026-04-29-00-45 --strict`
- PR URL: pending
- Merge state: pending
- Sandbox cleanup: pending

BLOCKED:
branch=agent/agent-9/bridge-adoption-closeout-evidence-2026-04-28-23-26
task=omx bridge_status compact Colony state
blocker=`git add ...` cannot write `.git/worktrees/.../index.lock` inside sandbox (`Read-only file system`), and escalation was rejected by approval auto-review due usage limit
next=stage, commit, push, open PR, merge, and cleanup once git index write approval is available
evidence=`git add README.md ... openspec/specs/omx-colony-bridge/spec.md` failed with `fatal: Unable to create '/home/deadpool/Documents/recodee/colony/.git/worktrees/colony__agent-9__bridge-adoption-closeout-evidence-2026-04-28-23-26/index.lock': Read-only file system`
