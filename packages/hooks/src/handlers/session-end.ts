import type { MemoryStore } from '@colony/core';
import type { HookInput } from '../types.js';

export async function sessionEnd(store: MemoryStore, input: HookInput): Promise<void> {
  const turns = store.storage
    .listSummaries(input.session_id)
    .filter((s) => s.scope === 'turn')
    .map((s) => s.content);
  if (turns.length === 0) {
    store.endSession(input.session_id);
    return;
  }
  const rolled = turns.slice(0, 20).join('\n');
  store.addSummary({
    session_id: input.session_id,
    scope: 'session',
    content: rolled,
  });
  store.endSession(input.session_id);
}
