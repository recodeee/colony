# agent-claude-fix-gain-output-double-word-and-add-hot-2026-05-14-13-40 (minimal / T1)

Branch: `agent/claude/fix-gain-output-double-word-and-add-hot-2026-05-14-13-40`

Tighten `colony gain` so dominance jumps off the page and the labels stop reading like
duplicated verbs.

- Top spend line now shows `(N% of total)` so an operation owning 98% of token spend
  is impossible to miss when scanning.
- New `Hot loop:` callout fires when a single op holds ≥70% of token spend across
  ≥100 calls, with a one-line nudge (narrow filters / compact mode / cache result).
- `Saved:` / `USD saved:` prefix labels renamed to `Net:` / `Net USD:` to drop the
  "Saved: X saved" double-word; `formatTokenDelta` / `formatUsdDelta` still emit the
  "X saved" / "X over" phrase verbatim so the `Top saving:` sentence reads naturally.
- Live sessions header trims its trailing `, -` when cost isn't configured.

## Handoff

- Handoff: change=`agent-claude-fix-gain-output-double-word-and-add-hot-2026-05-14-13-40`; branch=`agent/<your-name>/<branch-slug>`; scope=`TODO`; action=`continue this sandbox or finish cleanup after a usage-limit/manual takeover`.
- Copy prompt: Continue `agent-claude-fix-gain-output-double-word-and-add-hot-2026-05-14-13-40` on branch `agent/<your-name>/<branch-slug>`. Work inside the existing sandbox, review `openspec/changes/agent-claude-fix-gain-output-double-word-and-add-hot-2026-05-14-13-40/notes.md`, continue from the current state instead of creating a new sandbox, and when the work is done run `gx branch finish --branch agent/<your-name>/<branch-slug> --base dev --via-pr --wait-for-merge --cleanup`.

## Cleanup

- [ ] Run: `gx branch finish --branch agent/<your-name>/<branch-slug> --base dev --via-pr --wait-for-merge --cleanup`
- [ ] Record PR URL + `MERGED` state in the completion handoff.
- [ ] Confirm sandbox worktree is gone (`git worktree list`, `git branch -a`).
