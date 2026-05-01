# Add Colony Startup Panel

## Why

Agents currently need to inspect separate Colony tools before starting or resuming work. That makes the correct flow easy to skip: inbox first, then active lane, then ready queue.

## What

- Add a compact `startup_panel` MCP tool that composes existing hivemind, attention inbox, ready queue, plan, and claim data.
- Return active task, ready task, inbox count, blockers, claims, blocker/next/evidence fields, warnings, and exact next MCP call args.
- Keep this as a startup/resume surface, not a full dump.

## Impact

- Agents get one pre-work decision surface.
- Existing `attention_inbox`, `task_ready_for_agent`, and task-plan semantics remain the source of truth.
