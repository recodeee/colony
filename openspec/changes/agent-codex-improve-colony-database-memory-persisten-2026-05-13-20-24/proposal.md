## Why

- Colony memory writes should not create durable rows whose content disappears
  after privacy redaction.
- Common memory recall paths increasingly filter observations by kind, task,
  session, reply chain, and summary scope. Those reads should have stable
  indexes on both fresh and already-created SQLite databases.

## What Changes

- Normalize observation and summary write preparation through the same
  redact-then-compress guard.
- Return `-1` without creating a session or memory row when redaction leaves
  no searchable content.
- Add idempotent post-migration indexes for common observation and summary
  lookup predicates.
- Cover the behavior with focused storage/core tests.

## Impact

- A private-only summary no longer appears as an empty compressed memory row.
- Existing databases receive the new indexes when `Storage` opens them.
- No schema table shape changes or data migrations are required.
