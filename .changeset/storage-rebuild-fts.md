---
'@colony/storage': minor
'@imdeadpool/colony': patch
---

Add `Storage.rebuildFts()` so the CLI `reindex` command no longer
reaches through the type system to poke `better-sqlite3`. Behavior is
unchanged — `reindex` still runs the FTS5 `'rebuild'` statement — but
the public API is now typed and callers do not cast through `unknown`.
