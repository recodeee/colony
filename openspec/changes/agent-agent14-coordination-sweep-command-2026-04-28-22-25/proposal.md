# Add Coordination Sweep Command

## Why

Colony has decaying biological signals, but users need one command that makes
stale coordination state visible without mutating audit history.

## What Changes

- Add `colony coordination sweep`.
- Report stale claims, expired handoffs, expired messages, decayed proposals,
  stale hot files, and blocked downstream plan work.
- Support `--repo-root`, `--json`, and `--dry-run`.

## Impact

The command is read-only and actionable. It does not delete observations,
claims, proposals, messages, handoffs, or pheromone rows.
