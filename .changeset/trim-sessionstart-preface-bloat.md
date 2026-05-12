---
'@colony/config': minor
'@colony/hooks': minor
---

SessionStart hook now emits a compact one-line pointer to the quota-safe
operating contract by default instead of the full ~14-line verbose block,
saving ~350 tokens per SessionStart fire in every repo. New
`sessionStart.contractMode` setting (`'compact' | 'full' | 'none'`,
default `'compact'`) restores the legacy verbose preface (`'full'`) or
suppresses the contract entirely (`'none'`). AGENTS.md / CLAUDE.md keep
carrying the full protocol, so the compact pointer is enough for active
agents; one-time onboarding flows can opt into `'full'`.
