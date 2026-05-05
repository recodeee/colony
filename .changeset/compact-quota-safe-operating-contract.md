---
"@colony/config": patch
"@imdeadpool/colony-cli": patch
---

`quotaSafeOperatingContract` is rewritten as 7 dense paragraphs instead
of 36 numbered bullets. Every protocol token (tool names, RTK command
forms, section markers) and load-bearing phrase is preserved; only the
prose framing is collapsed. The constant is injected into the
SessionStart preface every IDE start, so the smaller payload reduces the
per-session token tax without changing the contract agents must follow.

`@colony/hooks` and `@colony/installers` re-export the constant
unchanged; their existing test suites (token-anchored
`QUOTA_SAFE_CONTRACT_TERMS` plus prose substring assertions) still pass.
