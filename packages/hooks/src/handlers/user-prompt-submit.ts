import type { MemoryStore } from '@cavemem/core';
import type { HookInput } from '../types.js';

/**
 * Injection budget — long chats on a busy task can accumulate dozens of
 * coordination messages. We show the most recent MAX and summarise the rest
 * so one chatty agent can't drown out the signal in another agent's context.
 */
const MAX_INJECTED_MESSAGES = 6;

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
  const all = store.storage
    .taskObservationsSince(task_id, sinceTs, 50)
    .filter((o) => o.session_id !== session_id);
  if (all.length === 0) return '';

  // Show most recent N; the tail of the ASC-ordered list. Older posts are
  // still accessible via task_timeline, so we just tell the agent how many
  // we dropped.
  const recent = all.slice(-MAX_INJECTED_MESSAGES);
  const skipped = all.length - recent.length;

  const lines: string[] = [`## New activity on task #${task_id} since your last turn`];
  for (const o of recent) {
    const head = o.content.split('\n')[0]?.slice(0, 120) ?? '';
    lines.push(`  #${o.id} [${o.kind}] ${head}`);
    // Handoffs get the exact accept call inline — same reasoning as the
    // SessionStart preface: without a copy-paste-ready invocation, agents
    // forget session_id and the call fails validation.
    if (o.kind === 'handoff') {
      lines.push(
        `    -> accept with: task_accept_handoff(handoff_observation_id=${o.id}, session_id="${session_id}")`,
      );
    }
  }
  if (skipped > 0) {
    lines.push(`  (${skipped} older message(s) omitted — call task_timeline to see them)`);
  }
  lines.push('Fetch full bodies via get_observations if you need them.');
  return lines.join('\n');
}
