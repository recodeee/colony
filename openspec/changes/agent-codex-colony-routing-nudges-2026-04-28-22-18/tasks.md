## 1. Runtime Routing Nudges

- [x] Add `hivemind_context.summary.next_action`, `summary.suggested_tools`, compact attention counts, and state-tool replacement hints.
- [x] Add `task_list` response hint and stronger repeated-use nudge when the caller has not used `task_ready_for_agent`.
- [x] Add `task_note_working` for task-scoped working notes without `task_id`.
- [x] Add health/adoption threshold signals for task selection, inbox use, claim use, and notepad replacement.

## 2. Verification

- [x] Add MCP tests for hivemind hints, task_list hints, and task_note_working resolution.
- [x] Add CLI health tests for adoption thresholds.
- [x] Run targeted test suites.
- [x] Run OpenSpec validation.

## 3. Completion / Cleanup

- [ ] Commit changes.
- [ ] Push branch.
- [ ] Open/update PR.
- [ ] Record PR URL.
- [ ] Verify PR state is `MERGED`.
- [ ] Verify sandbox worktree cleanup.
