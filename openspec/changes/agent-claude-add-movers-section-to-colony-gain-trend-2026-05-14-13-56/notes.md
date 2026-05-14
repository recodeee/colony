# agent-claude-add-movers-section-to-colony-gain-trend-2026-05-14-13-56 (minimal / T1)

Branch: `agent/claude/add-movers-section-to-colony-gain-trend-2026-05-14-13-56`

Add temporal regression detection to `colony gain` so the user can spot ops that
suddenly ramped (or stopped) in the recent window vs the rest of the queried period.

- The CLI runs `aggregateMcpMetrics` twice: once for the full requested window
  (existing call) and once for the trailing "recent" segment. Prior counts/tokens/
  errors are derived by subtraction. No new storage method.
- Default split: `recent_hours = max(windowHours / 7, 1)`. For the default 168h
  window, that's 24h recent vs 144h prior. `--recent-hours <n>` overrides.
- A row qualifies as a riser when its per-hour call rate is ≥ 2x the prior rate
  with ≥ 5 recent calls, or when it's brand new with ≥ 5 recent calls. Fallers
  use the mirror condition. Error risers fire when recent errors ≥ 3x prior and
  ≥ 3 absolute. Limits: top 3 risers + top 3 fallers + top 3 error risers.
- `(new)` and `(gone)` states render distinctly from percentage deltas so a brand-
  new hot loop isn't reported as "+∞%".
- `--no-movers` suppresses the section; the section is also silent on windows < 4h.
- JSON output gains `live.movers` with the same shape as the rendered rows so
  downstream tooling can consume the signal.

## Handoff

- Handoff: change=`agent-claude-add-movers-section-to-colony-gain-trend-2026-05-14-13-56`; branch=`agent/<your-name>/<branch-slug>`; scope=`TODO`; action=`continue this sandbox or finish cleanup after a usage-limit/manual takeover`.
- Copy prompt: Continue `agent-claude-add-movers-section-to-colony-gain-trend-2026-05-14-13-56` on branch `agent/<your-name>/<branch-slug>`. Work inside the existing sandbox, review `openspec/changes/agent-claude-add-movers-section-to-colony-gain-trend-2026-05-14-13-56/notes.md`, continue from the current state instead of creating a new sandbox, and when the work is done run `gx branch finish --branch agent/<your-name>/<branch-slug> --base dev --via-pr --wait-for-merge --cleanup`.

## Cleanup

- [ ] Run: `gx branch finish --branch agent/<your-name>/<branch-slug> --base dev --via-pr --wait-for-merge --cleanup`
- [ ] Record PR URL + `MERGED` state in the completion handoff.
- [ ] Confirm sandbox worktree is gone (`git worktree list`, `git branch -a`).
