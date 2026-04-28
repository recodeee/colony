# Tasks

## 1. Docs

- [x] Inspect existing README, Queen docs, and biological coordination spec.
- [x] Add concise README biological coordination model.
- [x] Include required Biology -> Colony mapping table.
- [x] Add examples for stale claim decay, proposal reinforcement and decay, Queen ordered waves, and local context before editing.
- [x] Update `docs/QUEEN.md` with publisher-not-commander guidance.
- [x] Link user-facing docs to the OpenSpec behavior contract.
- [x] Add OpenSpec delta requiring user-facing docs to stay summary-only.

## 2. Verification

- [x] Run docs/link/content checks.
  - `rg -n "## Biological Coordination Model|Ant \\| agent session|Stale claim decay|Proposal reinforcement and decay|Queen ordered waves|Local context before editing|biological model in practice|Queen publishes; workers pull" README.md docs/QUEEN.md`
  - `test -f openspec/specs/biological-coordination/spec.md`
  - `git diff --check`
- [x] Run OpenSpec validation.
  - `openspec validate --specs`
  - `openspec validate agent-agent-20-biological-coordination-docs-2026-04-28-22-26 --strict`

## 3. Completion

- [ ] Commit, push, PR, merge.
- [ ] Record final `MERGED` evidence and sandbox cleanup.
