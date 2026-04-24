---
'@imdeadpool/colony': patch
---

`colony config set` now coerces values using the settings schema instead
of a regex. The old heuristic parsed anything matching `^-?\d+$` as a
number — so `colony config set embedding.model 1.0` silently stored the
number `1`. The new logic walks `SettingsSchema` to the target field and
coerces only when the leaf type calls for it (booleans → bool, numbers
→ number, arrays/objects/records → JSON, enums and strings → raw). Zod
still validates the final result, so malformed input is rejected with a
shape-aware error rather than coerced into the wrong JS type.
