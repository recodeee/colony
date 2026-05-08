---
'@colony/core': patch
---

Stop attributing the storage-at-rest compression claim to live `savings_report` calls

The `Storage at rest (per observation)` reference row used to map to `['savings_report']`. Live `savings_report` output is structured JSON (~3.5k tokens per call) where the caveman compressor preserves technical tokens byte-for-byte, so the live comparison projected the row's 1k-token baseline against ~3.5k actual tokens and reported negative savings (e.g. `-155%`).

The row stays in the static reference — caveman compression really does shrink prose observations on disk — but it is now a structural claim about the storage layer rather than a per-call cost, so `mcp_operations` is empty. `savings_report` calls now show up under `unmatched_operations` instead of inflating the row.
