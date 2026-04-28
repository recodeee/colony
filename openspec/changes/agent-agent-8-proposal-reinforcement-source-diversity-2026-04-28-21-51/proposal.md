# Source-Diverse Proposal Reinforcement

## Why

Proposal promotion should represent independent colony evidence, not repeated clicks from one session. A single agent repeatedly reinforcing the same proposal can currently look like many agents finding the same work.

## What Changes

- Collapse same-session duplicate reinforcement before scoring.
- Weight different sessions from the same agent type as moderate evidence.
- Weight a different agent type/session as stronger evidence.
- Make `rediscovered` support stronger than `explicit` support.
- Keep the existing `task_reinforce` API and stored reinforcement rows.

## Impact

Foraging strength now tracks source diversity. Existing callers keep using `proposal_id`, `session_id`, and `kind`; promotion still happens when deterministic, decayed strength crosses the existing threshold.
