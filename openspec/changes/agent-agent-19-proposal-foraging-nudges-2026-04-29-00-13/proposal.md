# Proposal: proposal foraging nudges

## Problem

Colony health shows proposal/foraging signals at zero because agents bury future work in `task_post` notes and decisions instead of calling `task_propose`.

## Scope

- Add direct recommendation text when `task_post` content looks like future work.
- Add `colony debrief` guidance when `task_post` appears but `task_propose` does not.
- Document weak proposals, rediscovered reinforcement, and pending/promoted reports.
- Cover the recommendation text with focused tests.

## Completion

Record the PR URL, merge state, and sandbox cleanup evidence in `tasks.md` before closeout.
