## Why

Agents already read `hivemind_context` and `task_list`, but they often stop at passive inventory instead of checking inbox state, selecting claimable work, or writing task-scoped working notes. Documentation alone has not shifted behavior.

## What Changes

- Add runtime next-step hints and compact attention aliases to `hivemind_context`.
- Return a `task_list` hint, with a stronger warning after repeated inventory reads without `task_ready_for_agent`.
- Add `task_note_working` so agents can write Colony task notes without knowing `task_id`.
- Add adoption threshold signals to `colony health`.

## Impact

The MCP tools agents already call now route them toward `attention_inbox`, `task_ready_for_agent`, and `task_note_working` without blocking existing calls.
