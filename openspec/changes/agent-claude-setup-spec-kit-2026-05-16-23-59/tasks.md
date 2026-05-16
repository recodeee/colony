## Definition of Done

- All boxes below checked, agent branch reaches `MERGED` on `origin`, PR URL + state captured in the completion handoff.

## 1. Install

- [x] 1.1 Run `specify init --here --ai claude --force --ignore-agent-tools` in the agent worktree (specify-cli v0.8.11).
- [x] 1.2 Confirm `.specify/` populated, 14 `.claude/skills/speckit-*` skills installed, `CLAUDE.md` got the SPECKIT marker.

## 2. Cleanup

- [x] 2.1 Remove auto-generated heavy `openspec/plan/agent-claude-masterplan-setup-spec-kit-2026-05-16-23-59/` workspace (overkill for a CLI install).
- [x] 2.2 Replace the boilerplate proposal/spec stub with the real change description.

## 3. Verification

- [x] 3.1 `specify --version` reports `0.8.11`.
- [x] 3.2 `git status` shows only `.specify/`, `.claude/`, `CLAUDE.md`, and `openspec/changes/agent-claude-setup-spec-kit-2026-05-16-23-59/` modified.

## 4. Ship

- [ ] 4.1 Commit, push, open PR against `main`, enable auto-merge with squash.
- [ ] 4.2 Record PR URL + `MERGED` state in completion handoff.
- [ ] 4.3 Confirm sandbox worktree pruned post-merge.
