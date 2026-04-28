# Treat Messages As Alarm Pheromones

## Why

Directed task messages should draw attention only while they are actionable. Fresh messages can block or request replies, but stale, read, replied, retracted, or expired messages should stop acting like permanent inbox noise while remaining available for audit.

## What Changes

- Keep expired unread messages out of `attention_inbox` and unread-only `task_messages` views.
- Keep blocking messages prominent and uncoalesced until they are read, replied, retracted, or expired.
- Make `task_message_mark_read` return stable `MESSAGE_EXPIRED` after a message has already transitioned to `expired`.
- Document the live-inbox versus audit-listing distinction.

## Impact

Message bodies and observation rows remain in storage. The change affects attention rendering and lifecycle status only; it does not delete or rewrite audit history.
