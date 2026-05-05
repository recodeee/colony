# Add Operation-Level MCP Metrics

## Why

`colony gain --operation <name>` can identify a noisy MCP tool, but the
operation row still flattens success and failure cost into one average. When a
single tool loops with repeated structured errors, agents need to see whether
the waste is error-token volume, latency spikes, or a small number of large
responses without logging raw tool arguments.

## What Changes

- Derive success-token and error-token totals per operation.
- Derive peak input, output, total token, and duration values per operation.
- Show those details in the focused CLI view for `colony gain --operation`.
- Expose the same fields through `savings_report` JSON via the storage
  aggregate payload.

## Impact

The receipt model stays local and compact. No raw MCP arguments or response
bodies are persisted beyond the existing token/byte counts and structured
error reason fields.
