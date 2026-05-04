---
"@imdeadpool/colony-cli": patch
---

Apply `biome check --write` to clear the pre-existing formatting and import-ordering debt that was failing CI lint on every PR. Also rewrites three `try/catch { continue }` patterns in foraging code to the equivalent `null`-guarded `if (!x) continue` shape so biome's `noUnnecessaryContinue` rule passes without an unsafe auto-fix. No behavioral changes.
