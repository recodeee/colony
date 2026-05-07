# Colony Receipt Benchmarks

These scenarios make the receipts claim reproducible. They compare common
coordination loops against the compact Colony MCP flow that records
`mcp_metrics` rows.

Run:

```bash
pnpm run benchmark:receipts
pnpm run benchmark:receipts -- --json
```

Post the markdown table or JSON with your environment notes. The scenario file
is deterministic, so changes to the numbers are reviewable in git.

For local live receipts, run:

```bash
colony gain --honest --hours 168 --json
```

`--honest` intentionally omits the static reference model. It shows only live
`mcp_metrics` rows from your local MCP server.
