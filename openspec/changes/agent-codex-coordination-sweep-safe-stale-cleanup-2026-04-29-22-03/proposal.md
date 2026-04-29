# Safe stale claim cleanup in coordination sweep

## Problem

`colony coordination sweep --json` reports stale and expired/weak advisory claims, but ordinary stale claims remain after sweep unless they are part of the special downstream-blocker release path. This leaves health stuck with stale/expired claims even when there is no live operator and no dirty worktree protecting the claim.

## Solution

Teach the JSON sweep path to release or downgrade safe non-impact stale claims while retaining audit observations. Dirty worktree claims stay untouched. Stale Queen downstream blockers keep their dedicated rescue path and emit explicit recommended actions.

## Safety

The cleanup only runs for JSON sweep without `--dry-run`, skips dirty worktrees, skips live runtime sessions, and records `coordination-sweep` audit observations before removing active claim rows.
