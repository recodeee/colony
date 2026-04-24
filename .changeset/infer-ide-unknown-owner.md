---
"@colony/core": patch
"@colony/hooks": patch
"@colony/worker": patch
---

Infer the IDE owner for sessions whose id is hyphen-delimited (e.g. `codex-colony-usage-limit-takeover-verify-...`). Previously `MemoryStore.ensureSession` hardcoded `ide = 'unknown'` and the hook-side inferrer only matched the `codex@...` / `claude@...` form, so every on-demand-materialised row landed as `unknown` in the viewer. The worker's session index now also shows an owner chip and re-infers legacy `unknown` rows at render time (italic + `?` suffix to signal the value is derived, not authoritative), and Hivemind lane cards tag the owner directly.
