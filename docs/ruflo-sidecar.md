# Ruflo sidecar architecture

Ruflo should not be vendored into Colony. Colony is the coordination memory and
routing layer; Ruflo may run beside it as a sidecar MCP server or runtime that
owns its own execution loop.

## Boundary

Colony should coordinate, record, and route. It should not copy Ruflo swarm
execution, tool surfaces, runtime topology, browser automation, or security
logic. The integration point is an event/tool bridge, not a vendored source tree.

Allowed imports: concepts only.

- Concepts: sidecar process, MCP tool boundary, event stream, task routing, health/debrief summaries.
- Compact schemas for events and receipts, when written as Colony-owned contracts.
- Operator-facing lessons that improve Colony scheduling, handoff, or debrief behavior.

Forbidden imports:

- `@claude-flow` runtime code or package ownership.
- Ruflo swarm topology, scheduler internals, or execution policies.
- Ruflo browser/security tools.
- Large vendored trees from Ruflo or its examples.

Source size warning: `ruflo/` and `examples/ruflo/` are large, local, and
untracked. They are reference material only. Do not commit them, copy them into
Colony packages, or make Colony builds depend on them.

## Runtime shape

Ruflo can run as a separate sidecar:

```text
Ruflo tools/events
  -> Colony bridge
  -> compact observations
  -> suggestions / health / debrief
```

The bridge should translate Ruflo output into Colony-owned records:

- observations for compact event history and searchable debriefs
- task threads for user-visible work items and decisions
- handoffs for resumable ownership transfer
- claims for file or lane ownership
- active-session state for live runtime visibility
- learned patterns for future routing suggestions
- token receipts for usage accounting and cost review

The bridge should be lossy by default: keep small, useful summaries and hydrate
only when a caller asks for detail. Colony owns the durable coordination record;
Ruflo owns sidecar execution.

## Design rules

- Prefer event ingestion over API mirroring.
- Prefer compact summaries over raw logs.
- Prefer explicit contracts over source copying.
- Keep Ruflo optional: Colony must remain usable when the sidecar is absent.
- Treat Ruflo health as advisory input, not as Colony's source of truth.
