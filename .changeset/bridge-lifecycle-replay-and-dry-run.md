---
"colonyq": minor
---

`colony bridge lifecycle` gains `--replay <file>` and `--dry-run` so a saved `colony-omx-lifecycle-v1` envelope (e.g. captured `.pre.json`) can be routed offline through the real lifecycle logic without touching the live data dir. Combined with `--json`, this gives runtime integrators a CI-shaped harness for asserting on `route`, `event_type`, `extracted_paths`, and `ok`.
