// The classification table. Adding a new colony tool means adding one line here
// and re-running tests. Do NOT scatter these classifications across files.

export const COORDINATION_COMMIT_TOOLS = new Set([
  'mcp__colony__task_hand_off',
  'mcp__colony__task_accept_handoff',
  'mcp__colony__task_decline_handoff',
  'mcp__colony__task_claim_file',
  'mcp__colony__task_message',
  'mcp__colony__task_message_mark_read',
  'mcp__colony__task_message_claim',
  'mcp__colony__task_relay',
  'mcp__colony__task_accept_relay',
  'mcp__colony__task_decline_relay',
  'mcp__colony__task_propose',
  'mcp__colony__task_reinforce',
  'mcp__colony__task_plan_publish',
  'mcp__colony__task_plan_claim_subtask',
  'mcp__colony__task_plan_complete_subtask',
  'mcp__colony__task_post',
  'mcp__colony__task_link',
  'mcp__colony__task_unlink',
  'mcp__colony__agent_upsert_profile',
]);

export const COORDINATION_READ_TOOLS = new Set([
  'mcp__colony__hivemind',
  'mcp__colony__hivemind_context',
  'mcp__colony__task_list',
  'mcp__colony__task_timeline',
  'mcp__colony__task_messages',
  'mcp__colony__task_updates_since',
  'mcp__colony__attention_inbox',
  'mcp__colony__task_foraging_report',
  'mcp__colony__task_links',
  'mcp__colony__task_plan_list',
  'mcp__colony__task_plan_status_for_spec_row',
  'mcp__colony__task_suggest_approach',
  'mcp__colony__task_plan_validate',
  'mcp__colony__agent_get_profile',
  'mcp__colony__list_sessions',
  'mcp__colony__search',
  'mcp__colony__timeline',
  'mcp__colony__get_observations',
  'mcp__colony__recall_session',
]);

// Built-in editor tools whose use should be paired with a colony claim.
// Hard-coded to Claude Code / Codex names for now; extend as IDEs are added.
export const FILE_EDIT_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'mcp__omx_code_intel__apply_edit',
]);

export type ToolClass = 'commit' | 'read' | 'edit' | 'other';

export function classifyTool(toolName: string): ToolClass {
  if (COORDINATION_COMMIT_TOOLS.has(toolName)) return 'commit';
  if (COORDINATION_READ_TOOLS.has(toolName)) return 'read';
  if (FILE_EDIT_TOOLS.has(toolName)) return 'edit';
  return 'other';
}
