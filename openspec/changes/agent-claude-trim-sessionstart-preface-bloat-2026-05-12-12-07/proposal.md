## Why

The SessionStart hook injects the full `quotaSafeOperatingContract` (~14 lines, ~1.4 KB, ~350 tokens) into every Claude Code and Codex session in every repo, on every startup, resume, clear, and compact event. The contract restates rules that already live in repo `AGENTS.md` / `CLAUDE.md`, so the cost is paid for content the agent has already loaded. Combined with `Examples indexed (foraging)` and `Ready Queen sub-tasks`, the SessionStart preface eats ~400+ tokens of context before the user types anything. Reports from users (`recodee/colony` chat session, 2026-05-12) explicitly call this out as filling Claude Code's window too early.

## What Changes

- Add `sessionStart.contractMode` setting in `@colony/config`: `'compact' | 'full' | 'none'`, default `'compact'`.
- Add a one-line compact form of the contract: a pointer to AGENTS.md plus the three required pre-work tool names (`hivemind_context`, `attention_inbox`, `task_ready_for_agent`).
- `buildQuotaSafeOperatingPreface` dispatches on the setting: emits the compact pointer (default), the legacy full block (opt-in for new-repo onboarding), or nothing.
- Existing repos keep the contract reachable on demand by reading `AGENTS.md` or calling the existing `hivemind_context` MCP tool, which already returns `suggested_call` and coordination hints.

## Impact

- **Affected:** `packages/config/src/schema.ts`, `packages/config/src/instructions.ts`, `packages/hooks/src/handlers/session-start.ts`, `packages/hooks/test/session-start.test.ts`, `README.md`.
- **Token budget:** ~350 tokens saved per SessionStart fire on default install.
- **Migration:** existing user settings parse unchanged (new field is optional with a default). Users who prefer the legacy verbose preface set `sessionStart.contractMode: 'full'`.
- **No MCP wire change.** This trims a hook-side preface only; MCP tool surfaces are untouched.
- **Risk:** agents that relied on the verbose preface to recall the protocol now rely on AGENTS.md / `hivemind_context`. Mitigation: compact form names the three pre-work tools verbatim, and AGENTS.md is read on edit anyway.
