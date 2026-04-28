# Tasks

## 1. Proposal Decay

- [x] Inspect `task_propose`, `task_reinforce`, `task_foraging_report`, and proposal storage.
- [x] Add configurable proposal half-life, noise floor, and promotion threshold defaults.
- [x] Compute proposal strength from decayed reinforcement age.

## 2. Report And Audit Behavior

- [x] Omit pending proposals below the noise floor.
- [x] Show decayed strength in pending and promoted report rows.
- [x] Keep promoted proposals in a separate durable bucket.
- [x] Store reinforcement events as append-only auditable rows.

## 3. Tests

- [x] New proposal remains visible.
- [x] Ignored proposal decays below the report threshold.
- [x] Reinforced proposal remains visible.
- [x] Promoted proposal remains durable.
- [x] Same-session same-millisecond reinforcements remain auditable.

## 4. Completion

- [x] Run focused tests and typechecks.
- [x] Commit, push, PR, merge.
- [x] Record final `MERGED` evidence and sandbox cleanup.

Evidence:

- Implementation PR: https://github.com/recodeee/colony/pull/163
- Merge state: `MERGED`
- Merge commit: `b3c85777f7f726240591d5e04c748a3f9840f0bd`
- Sandbox cleanup: source worktree `colony__agent7__proposal-pheromone-decay-2026-04-28-21-56` pruned; local source branch removed.
