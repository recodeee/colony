export type HookName =
  | 'session-start'
  | 'user-prompt-submit'
  | 'pre-tool-use'
  | 'post-tool-use'
  | 'stop'
  | 'session-end';

/**
 * Union of fields sent by every supported IDE. Claude Code's payload uses
 * `tool_name` / `tool_response` / `last_assistant_message`; we keep the older
 * aliases (`tool`, `tool_output`, `turn_summary`) so other IDEs and our own
 * tests can drive the same handlers without translation.
 */
export interface HookInput {
  session_id: string;

  // Common Claude Code fields.
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  permission_mode?: string;

  // Identifies the invoking IDE. Claude Code does not send this — the
  // installer wires `--ide claude-code` into the hook command so the CLI
  // injects it before handlers run.
  ide?: string;

  // SessionStart: "startup" | "resume" | "clear" | "compact".
  source?: string;

  // SessionEnd: end reason.
  reason?: string;

  // UserPromptSubmit.
  prompt?: string;

  // PreToolUse / PostToolUse.
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  // Legacy aliases (kept for non-Claude-Code IDEs and tests).
  tool?: string;
  tool_output?: unknown;

  // Stop.
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  stop_reason?: string;
  // Legacy alias used by tests / other IDEs.
  turn_summary?: string;

  metadata?: Record<string, unknown>;
}

export interface HookResult {
  ok: boolean;
  ms: number;
  context?: string;
  error?: string;
}
