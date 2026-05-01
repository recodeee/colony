# Quota-pending claim resolution tools

## Problem

Quota relays and quota-exhausted handoffs weaken owned files to `handoff_pending`, but there is no direct MCP surface for another agent to accept, decline, or expire those claim rows. When a receiver cannot use the broader relay/handoff accept path, claim rows can stay stuck as active blockers.

## Solution

Add quota-claim MCP tools that resolve the claim row and linked baton together:

- `task_claim_quota_accept` transfers ownership to a replacement session, marks the linked relay/handoff accepted, and records an audit note.
- `task_claim_quota_decline` records the decline reason while leaving the relay/handoff visible to other agents.
- `task_claim_quota_release_expired` downgrades expired quota-pending claims to `weak_expired`, marks expired batons expired, and keeps audit observations.

## Safety

The tools require a task participant, validate relay/handoff targeting, preserve audit history, and avoid deleting claim history for expired quota rows.
