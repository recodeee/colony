import type { MemoryStore } from '@cavemem/core';
import type { HookInput } from '../types.js';

export async function userPromptSubmit(store: MemoryStore, input: HookInput): Promise<string> {
  // Compute the "since" cursor *before* recording this turn's prompt so the
  // window is `(last user_prompt, now)` rather than `(this prompt, now)`.
  const sinceTs = store.storage.lastObservationTsForSession(input.session_id, 'user_prompt');

  if (input.prompt) {
    store.addObservation({
      session_id: input.session_id,
      kind: 'user_prompt',
      content: input.prompt,
    });
  }

  return buildTaskUpdatesPreface(store, input.session_id, sinceTs);
}

/**
 * Turn-boundary awareness: inject any task-thread activity that happened
 * while this session was idle. This is the cheap, polling-free substitute
 * for websockets — agents operate in turns, and a new-messages banner at
 * turn boundaries covers ~80% of what real-time would feel like.
 */
function buildTaskUpdatesPreface(store: MemoryStore, session_id: string, sinceTs: number): string {
  const task_id = store.storage.findActiveTaskForSession(session_id);
  if (!task_id) return '';
  // First turn on this task has sinceTs === 0 — the session-start hook has
  // already injected pending handoffs, so suppress the duplicate here.
  if (sinceTs === 0) return '';
  const msgs = store.storage
    .taskObservationsSince(task_id, sinceTs, 20)
    .filter((o) => o.session_id !== session_id);
  if (msgs.length === 0) return '';

  const lines = [
    `## New activity on task #${task_id} since your last turn`,
    ...msgs.map((o) => {
      const head = o.content.split('\n')[0]?.slice(0, 160) ?? '';
      return `  [${o.kind}] #${o.id} ${head}`;
    }),
    'Fetch full bodies via get_observations if you need them.',
  ];
  return lines.join('\n');
}
