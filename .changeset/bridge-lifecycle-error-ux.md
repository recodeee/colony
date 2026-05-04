---
"@imdeadpool/colony-cli": patch
---

Make `colony bridge lifecycle` self-documenting: invalid envelopes now report which schema or `event_name` was wrong and list the seven required fields, and a new `--example` flag prints a parseable sample envelope so users following `colony health`'s suggested fix have something to pipe in.
