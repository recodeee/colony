export const quotaSafeOperatingContract = [
  '## Quota-safe Colony operating contract',
  'Coordination truth lives in Colony. Use OMX for runtime memory summaries. Use available MCP servers for repo, GitHub, CI, and docs context before guessing.',
  '',
  'RTK command policy: Always prefix shell commands with `rtk` for token-optimized output (e.g. `rtk ls`, `rtk read`, `rtk grep`, `rtk git status`, `rtk gh pr view`, `rtk pytest`, `rtk tsc`, `rtk lint`). Use `rtk err <cmd>` or `rtk test <cmd>` for failure-only output, `rtk proxy <command>` for raw passthrough. If `rtk` is unavailable, record that and run the underlying command compactly.',
  '',
  'Before work: Call hivemind_context. Call attention_inbox. Call task_ready_for_agent. Accept a pending handoff with task_accept_handoff (or decline). Claim the subtask with task_plan_claim_subtask. Claim each touched file with task_claim_file before edits. Write task_note_working with branch, task, blocker, next, evidence.',
  '',
  'During work: Update task_note_working after meaningful progress. Keep the next step explicit. Run focused verification for the touched behavior.',
  '',
  'Shutdown / finish contract: Before stopping, run git status and identify dirty files. If dirty, commit finished work, hand off unfinished work, or clean intentionally abandoned edits. Write task_note_working with branch, task, dirty files, blocker, next step, evidence. Release or weaken claims before abandoning work so stale strong ownership does not block the next agent.',
  '',
  'Before quota/session stop: Emit a quota_exhausted handoff with task_hand_off or task_relay, or release owned claims. Include claimed files, dirty files from git status, branch, last verification, and next step. Mark claims handoff-pending or release them before exit (no strong claims without a handoff or TTL). When unsure, run coordination sweep guidance first and follow its release/handoff recommendation.',
].join('\n');
