---
'@imdeadpool/colony': patch
---

Validate each JSONL row in `colony import` with a zod discriminated
union. Previously malformed rows were coerced with `String()` /
`Number()` and silently inserted as `NaN` timestamps or `"undefined"`
strings. Now the command fails fast with `<file>:<line>: <field>:
<message>` the moment a row does not match the export schema.
