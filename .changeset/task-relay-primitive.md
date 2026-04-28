---
"@colony/core": minor
"@colony/mcp-server": minor
---

Add `task_relay`: a coordination primitive for passing in-flight work to
another agent when the sender is being cut off (quota, rate-limit,
turn-cap) and can't write a thoughtful handoff. The sender provides one
sentence; everything else — recently edited files, active claims, recent
decisions and blockers, last baton-pass summary, search seeds — is
synthesized from the last 30 minutes of task-thread activity at emit
time. A `worktree_recipe` block (base branch, claims to inherit, optional
git sha, untracked-file warning) lets a receiver in a different worktree
set up an equivalent tree before editing.

Difference from `task_hand_off`: relays assume the sender is gone, so
their claims are *dropped* at emit time and re-claimed by the receiver
on accept (mirrors the `transferred_files` invariant — no third agent
can grab a file in the gap). The `expires_at` window is shorter (4h
default vs. 2h for handoffs but stricter ceiling — work the relay
describes goes stale fast).

Core (`@colony/core`):

- `TaskThread.relay()` / `acceptRelay()` / `declineRelay()` /
  `pendingRelaysFor()` parallel the handoff/wake/message primitives
  with their own typed metadata, error codes (`NOT_RELAY`,
  `RELAY_EXPIRED`), and content rendering.
- New exports: `RelayMetadata`, `RelayObservation`, `RelayArgs`,
  `RelayStatus`, `RelayTarget`, `RelayReason`. Existing
  `CoordinationKind` union extended with `'relay'`.
- Heterogeneous-metadata-safe synthesis of `last_handoff_summary`:
  branches on observation kind so `summary` (handoffs) and `one_line`
  (relays) both feed the field correctly when the most recent
  baton-pass is one or the other.

MCP (`@colony/mcp-server`):

- Three new tools: `task_relay`, `task_accept_relay`,
  `task_decline_relay`. Registered next to `task_message` so
  coordination primitives stay contiguous.
