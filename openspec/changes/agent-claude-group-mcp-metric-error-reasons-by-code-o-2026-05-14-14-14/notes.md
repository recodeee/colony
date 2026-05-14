# agent-claude-group-mcp-metric-error-reasons-by-code-o-2026-05-14-14-14 (minimal / T1)

Branch: `agent/claude/group-mcp-metric-error-reasons-by-code-o-2026-05-14-14-14`

Drop `error_message` from the error_reasons grouping key in `aggregateMcpMetrics`
so per-row counts sum to `error_count`. Handlers like `task_plan_claim_subtask`
embed unique session IDs in their messages ("sub-task is claimed by codex-X"),
which fragmented identical errors into many rows and pushed most out of the
3-row truncation. SQLite returns the latest message via the bare-column-with-
MAX optimization, keeping a diagnostic sample without bloating the key. Per-op
cap bumped from 3 → 8 since codes are low-cardinality. Verified on live DB:
`task_plan_claim_subtask` previously reported 7 of 93 errors in `Top error
reasons`; now reports 60 + 33 + 1 = 94 across three codes.

## Handoff

- Handoff: change=`agent-claude-group-mcp-metric-error-reasons-by-code-o-2026-05-14-14-14`; branch=`agent/<your-name>/<branch-slug>`; scope=`TODO`; action=`continue this sandbox or finish cleanup after a usage-limit/manual takeover`.
- Copy prompt: Continue `agent-claude-group-mcp-metric-error-reasons-by-code-o-2026-05-14-14-14` on branch `agent/<your-name>/<branch-slug>`. Work inside the existing sandbox, review `openspec/changes/agent-claude-group-mcp-metric-error-reasons-by-code-o-2026-05-14-14-14/notes.md`, continue from the current state instead of creating a new sandbox, and when the work is done run `gx branch finish --branch agent/<your-name>/<branch-slug> --base dev --via-pr --wait-for-merge --cleanup`.

## Cleanup

- [ ] Run: `gx branch finish --branch agent/<your-name>/<branch-slug> --base dev --via-pr --wait-for-merge --cleanup`
- [ ] Record PR URL + `MERGED` state in the completion handoff.
- [ ] Confirm sandbox worktree is gone (`git worktree list`, `git branch -a`).
