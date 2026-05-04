---
"@imdeadpool/colony-cli": patch
---

Default the hook subprocess to the user's canonical Colony home (resolved through `loadSettingsForCwd`) instead of forcing a per-repo `.omx/colony-home/data.db`. The previous default split observations away from `~/.colony/data.db` and pinned the claim-before-edit health metric at 0%. Repos that need per-repo isolation can opt back in via a checked-in `.colony/settings.json` `dataDir` override.
