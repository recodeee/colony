---
'@colony/storage': patch
'@colony/core': patch
---

Fix read-then-write race in claim cleanup paths

`releaseExpiredQuotaClaims` and `bulkRescueStrandedSessions` previously read
eligible claims outside their DEFERRED transaction, allowing two concurrent
callers to both snapshot the same rows and each emit a duplicate
`claim-weakened` or `rescue-stranded` audit observation.

The fix moves the claim read inside a `BEGIN IMMEDIATE` transaction on both
paths so the write lock is acquired before any row is inspected. The storage
`transaction()` helper gains an `{ immediate: true }` option that maps to
better-sqlite3's `.immediate()` mode. A new idempotency test confirms that
calling each cleanup path twice produces exactly one audit observation.
