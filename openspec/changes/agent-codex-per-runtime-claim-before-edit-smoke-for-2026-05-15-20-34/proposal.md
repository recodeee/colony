## Why

Claim-before-edit health depends on knowing which runtimes can emit lifecycle
hooks and which are MCP-only. Cursor and Gemini CLI currently install the
Colony MCP server, but they do not have native PreToolUse/PostToolUse hook
wiring in the installer. Add explicit per-runtime smoke coverage so future
installer work does not accidentally claim hook support or regress the MCP
namespace required for manual claims.

## What Changes

- Add Cursor installer smoke coverage in
  `packages/installers/test/cursor-claim-before-edit.test.ts`.
- Add Gemini CLI installer smoke coverage in
  `packages/installers/test/gemini-cli-claim-before-edit.test.ts`.
- Assert each runtime installs `mcpServers.colony`, removes stale `cavemem`,
  preserves unrelated settings, and does not write claim-before-edit lifecycle
  hook commands.

## Impact

- Test-only change for `@colony/installers`.
- The tests document current runtime support boundaries: Cursor and Gemini CLI
  remain MCP-only until a real lifecycle hook bridge is added.
