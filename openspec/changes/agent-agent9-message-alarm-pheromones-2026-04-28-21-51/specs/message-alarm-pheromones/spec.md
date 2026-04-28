## ADDED Requirements

### Requirement: Live Message Attention Expires

Colony SHALL treat task messages as live attention signals only until they are read, replied, retracted, or expired.

#### Scenario: expired unread message leaves live inbox

- **GIVEN** an unread task message whose TTL has elapsed
- **WHEN** an agent reads `attention_inbox` or an unread-only `task_messages` view
- **THEN** the message is omitted from live attention results
- **AND** the original observation remains available for audit

#### Scenario: audit listing reports expired status

- **GIVEN** an unread task message whose TTL has elapsed
- **WHEN** an audit-style message listing includes non-unread statuses
- **THEN** the message status is reported as `expired`

### Requirement: Blocking Messages Stay Prominent

Colony SHALL keep each unread blocking message visible as its own prominent attention item until the message is handled or expired.

#### Scenario: multiple blocking messages from one sender

- **GIVEN** multiple unread blocking messages from the same sender on the same task
- **WHEN** Colony builds attention summaries or coalesced message groups
- **THEN** each blocking message remains a singleton attention signal
- **AND** lower-urgency messages may be collapsed before blocking messages

### Requirement: Expired Read Attempts Are Stable

Colony SHALL return `MESSAGE_EXPIRED` for every read attempt on a message that expired before being read.

#### Scenario: repeated mark_read after expiry

- **GIVEN** a task message that expired before the recipient read it
- **WHEN** the recipient calls `task_message_mark_read` more than once
- **THEN** every call returns `MESSAGE_EXPIRED`
- **AND** the message remains stored for audit
