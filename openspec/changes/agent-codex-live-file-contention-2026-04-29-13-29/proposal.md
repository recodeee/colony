# Worktree Contention Report

## Why

Agents can hold separate managed worktrees while editing the same path. Colony needs a direct command that reports those conflicts before the edits collide at merge time.
`colony health` also needs compact live contention counters so an unstable branch explains the ownership conflict before typecheck fails.

## What Changes

- Inspect `.omx/agent-worktrees` and `.omc/agent-worktrees`.
- Collect branch, dirty files, claimed files, and active-session metadata per managed worktree.
- Report dirty-file collisions through `colony worktree contention --json`.
- Add `colony health` JSON/text metrics for live file contentions, protected file contentions, paused lanes, takeover requests, competing worktrees, and dirty contended files.
- Render the top five live same-file claim conflicts with owner, session, and branch.

## Verification

- Core unit test uses temp git worktrees across `.omx` and `.omc`.
- CLI test exercises `colony worktree contention --json`.
- Health tests prove live claim/worktree contention appears in JSON and text output.
