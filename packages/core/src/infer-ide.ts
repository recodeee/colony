/**
 * Best-effort mapping from a session id to the IDE / agent that created it.
 *
 * Hooks write `ide = input.ide ?? infer(session_id) ?? 'unknown'`. Without a
 * broad matcher, ids like `codex-colony-usage-limit-takeover-verify-...` — the
 * hyphen-delimited task-named sessions codex emits — fell through and landed
 * in storage as `unknown`. The viewer then shows every such row as an
 * unowned session, making it impossible to tell who ran what.
 *
 * Keep this list conservative: prefix inference is a heuristic, so we only
 * return a known IDE id and never guess from arbitrary strings.
 */
export function inferIdeFromSessionId(sessionId: string): string | undefined {
  if (!sessionId) return undefined;
  const prefix = sessionId.split(/[@\-:/_]/)[0]?.toLowerCase();
  if (!prefix) return undefined;
  switch (prefix) {
    case 'claude':
    case 'claudecode':
      return 'claude-code';
    case 'codex':
      return 'codex';
    case 'gemini':
      return 'gemini';
    case 'cursor':
      return 'cursor';
    case 'windsurf':
      return 'windsurf';
    case 'aider':
      return 'aider';
    default:
      return undefined;
  }
}
