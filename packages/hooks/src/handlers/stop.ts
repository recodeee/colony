import type { MemoryStore } from '@colony/core';
import type { HookInput } from '../types.js';

export async function stop(store: MemoryStore, input: HookInput): Promise<void> {
  const summary = input.turn_summary ?? input.last_assistant_message;
  if (!summary || !summary.trim()) return;
  store.addSummary({
    session_id: input.session_id,
    scope: 'turn',
    content: summary,
  });
}
