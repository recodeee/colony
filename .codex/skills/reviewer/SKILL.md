---
name: reviewer
description: Use when reviewing active multi-agent work, PRs, or handoffs where you need Cavemem's hivemind tool to map branch and task ownership before reading full session memory.
---

# Reviewer

Use this skill for review-shaped tasks where ownership matters:

- PR review on an active agent branch
- Handoff review
- "who owns this task?"
- conflict triage across worktrees
- stale lane vs live lane checks before touching code

## Fast path

1. Call `hivemind` with the target `repo_root` (or `repo_roots`).
2. Pick the smallest relevant session set by exact `branch`, `task`, `agent`, or `worktree_path`.
3. Only after you know which session matters:
   - use `search` for cross-session topic lookup
   - or `list_sessions` -> `timeline` when you already know the session
4. Fetch full bodies with `get_observations` only for the exact evidence you need.
5. Review the code or diff with findings first: bugs, regressions, missing tests, or ownership conflicts.

## Hivemind rules

- Treat `activity=working` or `activity=thinking` as a live lane.
- Treat `source=worktree-lock` without a matching active session as fallback telemetry, not proof.
- Prefer the freshest exact `branch` match over loose task-name similarity.
- Do not fetch observation bodies for every session "just in case". `hivemind` exists to stop that waste.

## Review checklist

- Confirm which branch or worktree owns the task.
- Check whether the lane is live, stalled, or dead.
- Pull only the memory evidence needed for the review claim.
- Review the actual diff or files after ownership is clear.
- Report findings first, highest risk first.

## Output contract

- Findings first.
- Cite the `branch`, `worktree_path`, or session evidence you used.
- Call out stale telemetry or ownership collisions explicitly.
- If no findings, say so and mention residual risk or missing verification.

## Example prompts

- `Review PR #2 with hivemind first so you know which branch still owns the lane.`
- `Check whether this handoff is stale or still live before I edit the worktree.`
- `Find who owns the runtime bug, then review only that lane's evidence.`
