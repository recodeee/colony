---
"colony": patch
"@colony/compress": patch
"@colony/config": patch
"@colony/core": patch
"@colony/embedding": patch
"@colony/hooks": patch
"@colony/installers": patch
"@colony/storage": patch
---

Rename the public CLI package and workspace package/import namespace from cavemem to Colony. The CLI binary is now `colony`, workspace imports use `@colony/*`, release scripts pack `colony`, and installed hook scripts call `colony`.
