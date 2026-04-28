import { type MemoryStore, PheromoneSystem } from '@colony/core';
import type { HookInput } from '../types.js';

/**
 * Injection budget — long chats on a busy task can accumulate dozens of
 * coordination messages. We show the most recent MAX and summarise the rest
 * so one chatty agent can't drown out the signal in another agent's context.
 */
const MAX_INJECTED_MESSAGES = 6;
const CLAUDE_EDIT_READ_GUARD =
  'Claude Code edit safety: Read each existing target file before Edit/Update/MultiEdit, or Claude Code rejects with "File must be read first".';

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

  const activity = buildTaskUpdatesPreface(store, input.session_id, sinceTs);
  const conflicts = buildConflictPreface(store, input.session_id);
  const pheromones = buildPheromoneConflictPreface(store, input.session_id);
  const editGuard = input.ide === 'claude-code' ? CLAUDE_EDIT_READ_GUARD : '';
  return [editGuard, activity, conflicts, pheromones].filter(Boolean).join('\n\n');
}

/**
 * Active-edit collision warning. Surfaces files that *other* sessions on
 * the same task have claimed in the last 5 minutes — i.e. work that is
 * genuinely live, not stale breadcrumbs. Agents that see this preface
 * should coordinate via task_post or task_hand_off before editing.
 *
 * Exported so hook-integration tests can drive the preface builder without
 * the full runner/transport stack.
 */
export function buildConflictPreface(store: MemoryStore, session_id: string): string {
  const task_id = store.storage.findActiveTaskForSession(session_id);
  if (task_id === undefined) return '';

  // 5-minute active-edit window. Short by design: we're looking for "live
  // overlap", not "someone touched this yesterday". A wider window would
  // raise false-positive rate and agents learn to ignore noisy warnings.
  const RECENT_WINDOW_MS = 5 * 60_000;
  const since = Date.now() - RECENT_WINDOW_MS;
  const recent = store.storage
    .recentClaims(task_id, since)
    .filter((c) => c.session_id !== session_id);
  if (recent.length === 0) return '';

  // Group by session so "codex is editing X, Y, Z" reads cleaner than three
  // separate lines. Clustered warnings are easier to reason about than
  // disjoint ones — "I should stay off codex's work" beats three bullets.
  const bySession = new Map<string, string[]>();
  for (const c of recent) {
    const list = bySession.get(c.session_id) ?? [];
    list.push(c.file_path);
    bySession.set(c.session_id, list);
  }

  const lines = ['## Files being actively edited by other sessions'];
  for (const [sess, paths] of bySession) {
    lines.push(`  ${sess}: ${paths.join(', ')}`);
  }
  lines.push('Coordinate via task_post or task_hand_off before editing these files.');
  return lines.join('\n');
}

/**
 * Pheromone-based territory warning. Complements buildConflictPreface: the
 * claim preface fires on "someone else just edited this", this one fires on
 * "I have history here AND another session has strong recent activity".
 *
 * The decay-graded threshold filters out files whose other-session trail
 * has evaporated below the noise floor — a once-touched file from an hour
 * ago is not a collision risk even if a claim row technically still exists.
 *
 * Exported so hook-integration tests can drive the preface builder without
 * the full runner/transport stack.
 */
export function buildPheromoneConflictPreface(store: MemoryStore, session_id: string): string {
  const task_id = store.storage.findActiveTaskForSession(session_id);
  if (task_id === undefined) return '';

  // Threshold 1.0 = "one fresh deposit worth, undecayed". A single recent
  // touch from another session is enough to raise a territory warning.
  // Tune after real usage: raise to 2.0 if the warning fires too often.
  const COLLISION_THRESHOLD = 1.0;

  const pheromones = new PheromoneSystem(store.storage);
  const trails = pheromones.strongestTrails(task_id, 0.1);

  const conflicts = trails.filter((trail) => {
    const mine = trail.bySession.find((s) => s.session_id === session_id);
    if (!mine) return false;
    const others = trail.bySession.filter((s) => s.session_id !== session_id);
    return others.some((s) => s.strength >= COLLISION_THRESHOLD);
  });
  if (conflicts.length === 0) return '';

  const lines = ['## Active pheromone trails overlapping with yours'];
  for (const trail of conflicts) {
    const mine = trail.bySession.find((s) => s.session_id === session_id);
    const dominant = trail.bySession
      .filter((s) => s.session_id !== session_id)
      .sort((a, b) => b.strength - a.strength)[0];
    if (!mine || !dominant) continue;
    lines.push(
      `  ${trail.file_path}  ${dominant.session_id} strong (${dominant.strength.toFixed(1)}), you weaker (${mine.strength.toFixed(1)})`,
    );
  }
  lines.push('High cross-agent activity — coordinate before editing these files.');
  return lines.join('\n');
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
    if (o.kind === 'wake_request') {
      lines.push(
        `    -> respond with: task_message(task_id=${task_id}, session_id="${session_id}", agent="<your agent>", content="...") or task_post`,
      );
    }
  }
  if (skipped > 0) {
    lines.push(`  (${skipped} older message(s) omitted — call task_timeline to see them)`);
  }
  lines.push('Fetch full bodies via get_observations if you need them.');
  return lines.join('\n');
}
