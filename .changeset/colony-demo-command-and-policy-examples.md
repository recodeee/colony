---
'@imdeadpool/colony-cli': patch
---

Add `colony demo`: a 60-second guided walkthrough of file-claim contention prevention. Two simulated agents (`claude-code` and `codex`) join the same task and try to claim `src/api.ts`; the second agent gets `blocked_active_owner`, then `claude-code` releases and `codex` retries successfully. The demo runs against an isolated temp data dir and cleans up on exit, with `--json` for a structured transcript and `--keep-data` for inspection. Also ship pre-baked `~/.colony/settings.json` fragments under `examples/policies/` for Next.js monorepos, Python packages, and Rust workspaces — each fragment lists stack-appropriate `privacy.excludePatterns` (build output, caches, `.env`) and `protected_files` (lockfiles, root config). README points to both surfaces from the install block.
