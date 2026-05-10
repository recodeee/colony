# Design: Colony-as-tracker

## Status

Accepted for `colony-symphony-import`.

## Context

Symphony's upstream specification uses Linear as the tracker because the source
service is a Linear-backed scheduler and runner. Colony already has its own task
threads, file claims, task plans, handoffs, ready-task routing, and OpenSpec
integration. Using Linear as the adoption tracker would add an external tracker
that duplicates Colony's coordination model instead of proving it.

## Decision

Colony adoption uses `Colony-as-tracker`.

Linear-as-tracker is N/A for this port. Symphony tracker responsibilities map
onto Colony primitives:

| Symphony responsibility | Colony primitive |
| --- | --- |
| Candidate issue fetch | `task_ready_for_agent`, `task_plan_claim_subtask` |
| State refresh | task thread state, task timeline, claim state |
| Terminal fetch | completed/blocked task state plus OpenSpec evidence |
| Dispatch claim | task plan subtask claim plus file claims |
| Tracker handoff | `task_post`, `task_hand_off`, `task_relay` |
| Operator evidence | task notes, structured logs, OpenSpec tasks, PR evidence |

## Consequences

- Core conformance work must not require Linear credentials, Linear GraphQL, or
  Linear project state.
- Symphony Section 18.2 Linear GraphQL behavior remains a RECOMMENDED extension,
  not a core requirement.
- Wave 5 reconciliation must treat observed Colony task state as read/stop/cleanup
  input, not implicit permission to write status transitions.
- Future tracker adapters can be proposed separately without changing the
  umbrella import decision.
