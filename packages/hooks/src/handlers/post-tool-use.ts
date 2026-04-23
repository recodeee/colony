import { PheromoneSystem, type MemoryStore } from '@cavemem/core';
import type { HookInput } from '../types.js';

/**
 * Tool names whose `file_path` input indicates "this agent just edited that
 * file". Conservative on purpose — `Read` and `Glob` aren't claim-worthy
 * because they don't mutate; `Bash` isn't because we can't reliably parse
 * file paths out of arbitrary shell. Expand only when a new tool
 * demonstrably means "I am editing this file".
 */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Claims older than this window are considered stale and no longer count
 * as "active editing" for the purpose of conflict warnings. Matches the
 * default handoff TTL so the two user-facing timeouts stay aligned.
 */
const STALE_CLAIM_MS = 30 * 60_000;

export async function postToolUse(store: MemoryStore, input: HookInput): Promise<void> {
  const tool = input.tool_name ?? input.tool ?? 'unknown';
  const toolInput = input.tool_input;
  const toolOutput = input.tool_response ?? input.tool_output;
  const body =
    `${tool} input=${stringifyShort(toolInput)} output=${stringifyShort(toolOutput)}`.slice(
      0,
      4000,
    );
  if (!body.trim()) return;

  // Capture touched files in the observation metadata. Parsing content for
  // file_path later would require reversing compression — cheap to record
  // at write time, expensive to recover at query time. The `observe` and
  // `debrief` commands both depend on this surface for edit-vs-claim
  // diagnostics, so we pay the tiny write cost unconditionally.
  const touchedFiles = extractTouchedFiles(tool, toolInput);
  const metadata: Record<string, unknown> = { tool };
  if (touchedFiles.length > 0) metadata.file_path = touchedFiles[0];

  store.addObservation({
    session_id: input.session_id,
    kind: 'tool_use',
    content: body,
    metadata,
  });

  // Side effect: record a claim for every file this tool edited. Observed
  // (not predictive) — the agent doesn't have to know the claim system
  // exists for the claim system to protect its work. The next session that
  // touches the same file gets a warning in its UserPromptSubmit preface.
  autoClaimFromToolUse(store, input);

  // Second, finer-grained side effect: leave an ambient pheromone trail.
  // Claims are binary ("who owns this now"); pheromones are graded
  // ("how much activity has happened here recently"). Both are cheap to
  // write; the preface code decides which one to surface at read time.
  depositPheromoneFromToolUse(store, input);
}

/**
 * Extract file paths that a tool call mutated. Returns `[]` when the tool
 * isn't a write tool or the input shape isn't recognisable — silent-skip
 * rather than throw, because PostToolUse runs on every tool call and any
 * error here would degrade every turn.
 */
export function extractTouchedFiles(toolName: string, toolInput: unknown): string[] {
  if (!WRITE_TOOLS.has(toolName)) return [];
  if (typeof toolInput !== 'object' || toolInput === null) return [];
  const input = toolInput as Record<string, unknown>;
  if (typeof input.file_path === 'string' && input.file_path.length > 0) {
    return [input.file_path];
  }
  return [];
}

/**
 * Auto-claim files the current session just edited. No-op when the session
 * isn't joined to a task — solo agents don't need claims because there's
 * no one to conflict with.
 *
 * Returns the list of files newly claimed and the list of files that were
 * held by a different session at the moment we took over. Exposed for
 * tests; the main handler ignores the return value because the conflict
 * surfacing happens next turn via buildConflictPreface, not mid-tool.
 */
export function autoClaimFromToolUse(
  store: MemoryStore,
  input: Pick<HookInput, 'session_id' | 'tool_name' | 'tool' | 'tool_input'>,
): { claimed: string[]; conflicts: Array<{ file_path: string; other_session: string }> } {
  const toolName = input.tool_name ?? input.tool ?? '';
  const files = extractTouchedFiles(toolName, input.tool_input);
  if (files.length === 0) return { claimed: [], conflicts: [] };

  const task_id = store.storage.findActiveTaskForSession(input.session_id);
  if (task_id === undefined) return { claimed: [], conflicts: [] };

  const claimed: string[] = [];
  const conflicts: Array<{ file_path: string; other_session: string }> = [];

  for (const file_path of files) {
    // Check-then-claim: the gap is irrelevant for correctness because
    // we're not enforcing a lock, we're surfacing observed overlap. Two
    // separate ops let us report "this WAS someone else's before I took
    // over" cleanly in the return value.
    const existing = store.storage.getClaim(task_id, file_path);
    if (
      existing &&
      existing.session_id !== input.session_id &&
      Date.now() - existing.claimed_at < STALE_CLAIM_MS
    ) {
      conflicts.push({ file_path, other_session: existing.session_id });
    }
    store.storage.claimFile({ task_id, file_path, session_id: input.session_id });
    claimed.push(file_path);
  }

  return { claimed, conflicts };
}

/**
 * Leave pheromone on every file this tool touched. No-op when the session
 * isn't on a task (solo work needs no coordination) or when the tool wasn't
 * a write tool. Unlike auto-claim, this never conflicts, never reports
 * back — deposits are fire-and-forget. The decay math means "did the
 * deposit matter" is a question for the next turn's conflict surface, not
 * this turn's hook.
 *
 * Exposed for tests; the main handler ignores the return value.
 */
export function depositPheromoneFromToolUse(
  store: MemoryStore,
  input: Pick<HookInput, 'session_id' | 'tool_name' | 'tool' | 'tool_input'>,
): { deposited: string[] } {
  const toolName = input.tool_name ?? input.tool ?? '';
  const files = extractTouchedFiles(toolName, input.tool_input);
  if (files.length === 0) return { deposited: [] };

  const task_id = store.storage.findActiveTaskForSession(input.session_id);
  if (task_id === undefined) return { deposited: [] };

  const pheromones = new PheromoneSystem(store.storage);
  for (const file_path of files) {
    pheromones.deposit({ task_id, file_path, session_id: input.session_id });
  }
  return { deposited: files };
}

function stringifyShort(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.length > 500 ? `${v.slice(0, 500)}…` : v;
  try {
    const s = JSON.stringify(v);
    return s.length > 500 ? `${s.slice(0, 500)}…` : s;
  } catch {
    return String(v);
  }
}
