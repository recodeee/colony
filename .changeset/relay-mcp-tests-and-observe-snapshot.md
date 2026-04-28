---
"@colony/mcp-server": patch
"@imdeadpool/colony-cli": patch
---

Close two test gaps that were quiet failure modes.

**`task_relay` MCP-level lifecycle tests** (`apps/mcp-server/test/task-threads.test.ts`):
the relay primitive shipped without integration coverage in the MCP
test suite — only core-level unit tests existed. Added four lifecycle
tests round-tripped through the MCP client transport that pin the
contract reviewers actually care about: claims-drop-at-emit, receiver
re-claim on accept, decline-cancels-and-blocks-future-accept, directed
relay refuses non-target agents, expired relay flips status to
`expired` instead of staying `pending`. Without these tests an
internal storage/metadata change could silently break the receiver's
re-claim path or leave expired relays advertising themselves as live.

**`renderFrame` snapshot test** (`apps/cli/test/observe.test.ts`):
the `colony observe` dashboard's unclaimed-edits footer is the
load-bearing diagnostic for whether proactive claiming is happening,
but the renderer wasn't under test — a metadata field rename or a
`safeJson` typo would have surfaced as nonsense on the dashboard, the
worst way to find out. `renderFrame` is now exported and a Vitest
suite seeds a deterministic fixture (frozen clock, kleur disabled),
calls the renderer, and asserts on the structural anchors that would
break under those regressions: task header, participants, claims,
pending handoffs (`from_agent → to_agent: summary`), and the
unclaimed-edits footer in both populated and zero-state forms.
