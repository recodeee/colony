# Contributor Policy

## Problem

The README had a short contributor note, but contributors did not have a single
policy that explains the current Colony + `gx` workflow, PR expectations, and
how to report coordination friction from real work.

## Change

- Expand `CONTRIBUTING.md` into the current contribution policy.
- Document the `gx branch start` and `gx branch finish` PR flow.
- Require PRs to include verification and a coordination-friction report.
- Keep README's contributing section as the quick entry point.

## Acceptance

- New contributors can find the current contribution flow from `README.md`.
- `CONTRIBUTING.md` names the Colony startup loop and claim-before-edit flow.
- PR guidance asks contributors to report stale claims, confusing handoffs,
  missing session context, noisy proposals, stranded sessions, missed hot files,
  and edits before claim.
- Policy reinforces small observable primitives over central orchestration.

## Verification

- `openspec validate --specs`: 2 passed, 0 failed.
- `git diff --check`: passed.
- `pnpm exec biome check CONTRIBUTING.md README.md openspec/changes/agent-codex-document-contributing-policy-2026-05-06-01-18/colony-spec.md`: blocked because this worktree's linked `node_modules` does not contain `@biomejs/biome/bin/biome`.
