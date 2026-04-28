# Ordered Wave Planning MCP

## Why

Agents can already publish claimable task plans through MCP, and Queen can infer some wave dependencies, but `task_plan_publish` cannot accept explicit wave ordering from an MCP caller. Agents need one structured publish call that turns flat subtasks plus wave hints into claimable ordered work.

## What Changes

- Add ordered wave inputs to `task_plan_publish`.
- Reorder flat subtasks by wave hints and add previous-wave dependencies before publication.
- Return compact `waves` and `claim_instructions` from MCP publish responses.
- Apply the same response guidance to Queen plan publication.

## Impact

Agents can publish ordered wave plans without hand-wiring every dependency. Existing flat `task_plan_publish` callers keep the current behavior when they omit wave hints.
