# Codex/OMX Pre-Tool Smoke

## Intent

Provide a local smoke command that proves a fresh Codex/OMX lifecycle edit emits `pre_tool_use` before `post_tool_use` and contributes nonzero claim-before-edit coverage.

## Scope

- Add a focused `@colony/hooks` smoke test using an isolated temp repo and store.
- Add `pnpm smoke:codex-omx-pretool` as the local command.
- Document the command and the assertions it proves in `README.md`.

## Acceptance

- The smoke starts a fresh Codex/OMX lifecycle session and binds an active task.
- The smoke claims one real file before edit.
- The smoke emits `pre_tool_use`, mutates the file, and emits linked `post_tool_use`.
- The smoke asserts ordered lifecycle rows, normalized real file path, visible claim state, `pre_tool_use_signals > 0`, and `edits_claimed_before > 0` in a short stats window.

## Verification

```bash
pnpm smoke:codex-omx-pretool
```
