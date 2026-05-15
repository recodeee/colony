## Why

- Proposed task threads can remain in `proposal_status='proposed'` forever when no queen/operator approves them. The worker needs an automated cleanup path so stale proposals stop inflating scout open-proposal counts and cluttering ready-work surfaces.

## What Changes

- Add a worker job that archives proposed tasks older than seven days.
- Decrement the proposing agent's `open_proposal_count` when an old proposal is archived.
- Record a task-scoped `proposal-auto-archived` observation and structured worker log output for auditability.
- Register the job in the worker runtime on a six-hour cadence.

## Impact

- Affected surface: `@colony/worker` startup and proposal task-thread cleanup.
- Risk is limited to rows already marked `proposal_status='proposed'` and older than the retention window.
- Focused worker tests cover stale-vs-fresh behavior, count decrementing, observation emission, and structured logging.
