## Why

Operators configure `COLONY_MCP_INPUT_USD_PER_1M` and
`COLONY_MCP_OUTPUT_USD_PER_1M` so Colony can show live spend. The regular
`colony gain` table already carries cost fields, but the compact summary view
only reported token volume and savings. This makes cost-aware runs surface USD
by default across the gain views while keeping an explicit opt-out for token-only
output.

## What Changes

- Add `colony gain --no-cost` as the escape hatch for suppressing USD cost
  output even when CLI flags or environment rates are configured.
- Thread the active cost basis into `colony gain --summary`.
- Show total and average USD cost in the summary headline, plus a Cost column in
  the summary By Operation table, when rates are configured.

## Impact

- Affected surface: `apps/cli/src/commands/gain.ts`.
- Existing token-only behavior is preserved when no rates are configured, or
  when `--no-cost` is used.
- JSON keeps using the aggregate cost basis returned by storage; `--no-cost`
  sends no cost rates, so JSON payloads report `configured: false`.
