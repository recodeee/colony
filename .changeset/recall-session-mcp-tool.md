---
'@colony/mcp-server': minor
'@imdeadpool/colony': minor
---

Add `recall_session` MCP tool. An agent passes a `target_session_id` plus its own `current_session_id`, and the tool returns a compact timeline of the target (IDs + kind + ts only — bodies still come from `get_observations(ids[])`) while writing a `kind: 'recall'` observation into the *caller's* session as the audit trail.

The recall observation introduces a new wire contract that other code may filter on:

- `kind === 'recall'`
- `metadata.recalled_session_id` — the consulted session
- `metadata.owner_ide` — `inferIdeFromSessionId` fallback when the target's `ide` column is `unknown`, so foreign-session recalls stay traceable without re-inferring at read time
- `metadata.observation_ids` — the timeline slice that was returned
- `metadata.around_id` and `metadata.limit` — the request parameters that produced the slice

Both session ids are validated via `Storage.getSession()` before any write. `MemoryStore.addObservation` routes through `ensureSession` (memory-store.ts:96), which silently materialises a missing sessions row — without these checks a typo'd `current_session_id` would create a phantom session and write a recall observation into it. Errors come back as `{ code: 'SESSION_NOT_FOUND', error }`.

Also extends `GET /api/sessions/:id/observations` on the worker viewer with an `?around=<id>&limit=<n>` query so the same paged timeline is reachable from the HTTP surface (the route already proxied to `Storage.timeline`, which has supported `aroundId` for a while). Cross-session `?around` ids cleanly return `[]` rather than spilling into the target window, matching the SQL filter on `session_id`.
