---
"@colony/core": minor
"@colony/mcp-server": minor
---

Eight-part overhaul of the `task_message` system so directed-agent messaging
behaves more like a real coordination channel than a one-shot inbox.

`@colony/core`:

- `MessageMetadata` gains `expires_at`, `retracted_at`, `retract_reason`, and
  `claimed_by_session_id` / `claimed_by_agent` / `claimed_at`. `MessageStatus`
  picks up `expired` and `retracted` terminal states. `parseMessage` backfills
  the new fields to `null` so legacy rows still pass the strict-null
  visibility predicates without a migration.
- `TaskThread.postMessage` accepts `expires_in_ms`, auto-claims a still-
  unclaimed `to_agent='any'` broadcast on reply, and keeps reply-chain depth
  authoritative at 1-deep — only the immediate parent flips to `replied`.
- New `TaskThread.retractMessage` (sender-only, refuses replied messages) and
  `TaskThread.claimBroadcastMessage` (idempotent for the existing claimer,
  rejects directed messages with `NOT_BROADCAST`).
- `TaskThread.markMessageRead` writes a sibling `message_read` observation
  so the original sender's inbox can render read receipts; past-TTL reads
  flip the on-disk status to `expired` and throw `MESSAGE_EXPIRED`.
- `pendingMessagesFor` and `listMessagesForAgent` filter retracted, expired,
  and other-agents'-claimed broadcasts. Inbox summaries surface `expires_at`,
  `is_claimable_broadcast`, and the claim state.
- `buildAttentionInbox` adds `summary.blocked` (gates non-message lanes when
  any unread is `blocking`), `coalesced_messages` (groups by task / sender /
  urgency), and `read_receipts` (drops once the recipient replies). New
  `read_receipt_window_ms` / `read_receipt_limit` options.

`@colony/mcp-server`:

- `task_message` accepts `expires_in_minutes` (max 7 days).
- New `task_message_retract` and `task_message_claim` tools.
- `task_messages` shape now includes `expires_at`, `is_claimable_broadcast`,
  `claimed_by_session_id`, and `claimed_by_agent`.
- Tool descriptions document the 1-deep reply contract, retract semantics,
  TTL behavior, and broadcast-claim flow.
