import type { ObservationRow, TaskClaimRow, TaskRow } from '@colony/storage';
import { type HivemindSession, readHivemind } from './hivemind.js';
import { inferIdeFromSessionId } from './infer-ide.js';
import type { MemoryStore } from './memory-store.js';
import { type RelayReason, TaskThread } from './task-thread.js';

const DEFAULT_STRANDED_AFTER_MS = 10 * 60_000;
const RESCUE_RELAY_TTL_MS = 30 * 60_000;
const ONE_LINE_LIMIT = 240;

export interface StrandedRescueOptions {
  stranded_after_ms?: number;
  dry_run?: boolean;
}

export interface StrandedRescueOutcome {
  scanned: number;
  rescued: Array<{
    session_id: string;
    task_id: number;
    relay_observation_id: number;
    inherited_claims: string[];
    rescue_reason: string;
  }>;
  skipped: Array<{ session_id: string; reason: string }>;
}

interface StrandedSessionRow {
  session_id?: string;
  id?: string;
  repo_root?: string | null;
  cwd?: string | null;
  worktree_path?: string | null;
  branch?: string | null;
  last_observation_ts?: number | string | null;
  last_tool_error?: string | null;
}

interface RecentToolErrorRow {
  tool?: string | null;
  tool_name?: string | null;
  name?: string | null;
  message?: string | null;
  error?: string | null;
  content?: string | null;
  ts?: number | string | null;
}

interface RescueStorage {
  findStrandedSessions(args: { stranded_after_ms: number }): StrandedSessionRow[];
  recentToolErrors?: unknown;
}

export function rescueStrandedSessions(
  store: MemoryStore,
  options: StrandedRescueOptions = {},
): StrandedRescueOutcome {
  const stranded_after_ms = options.stranded_after_ms ?? DEFAULT_STRANDED_AFTER_MS;
  const dryRun = options.dry_run ?? false;
  const storage = store.storage as typeof store.storage & RescueStorage;
  const candidates = storage.findStrandedSessions({ stranded_after_ms });
  const outcome: StrandedRescueOutcome = { scanned: candidates.length, rescued: [], skipped: [] };

  for (const candidate of candidates) {
    const session_id = candidateSessionId(candidate);
    if (!session_id) {
      outcome.skipped.push({ session_id: '', reason: 'missing session_id' });
      continue;
    }

    const repoRoot = candidateRepoRoot(candidate);
    const snapshot = readHivemind({
      ...(repoRoot !== undefined ? { repoRoot } : {}),
      limit: 100,
    });
    if (!isLiveActiveSession(candidate, snapshot.sessions)) {
      outcome.skipped.push({ session_id, reason: 'session not alive' });
      continue;
    }

    const claimsByTask = groupClaimsByTask(store, session_id);
    if (claimsByTask.size === 0) {
      outcome.skipped.push({ session_id, reason: 'no claims' });
      continue;
    }

    const lastToolError = latestToolError(storage, session_id, candidate);
    const relayReason = relayReasonFor(lastToolError);
    const rescue_reason = rescueReasonFor(lastToolError);
    const from_agent = inferAgent(session_id);
    const last_observation_ts = lastObservationTs(store, session_id, candidate);
    const one_line = rescueOneLine(store, session_id);

    for (const [task_id, claims] of claimsByTask.entries()) {
      const inherited_claims = claims.map((claim) => claim.file_path);
      const observerMetadata = {
        kind: 'observer-note',
        action: 'rescue-relay',
        stranded_session_id: session_id,
        task_id,
        last_observation_ts,
        last_tool_error: renderToolError(lastToolError),
        claim_count: inherited_claims.length,
        rescue_reason,
        dry_run: dryRun,
      };
      store.addObservation({
        session_id,
        kind: 'observer-note',
        task_id,
        content: `Preparing rescue relay for stranded session ${session_id} on task ${task_id}; ${inherited_claims.length} claim(s) will be released.`,
        metadata: observerMetadata,
      });

      if (dryRun) {
        outcome.rescued.push({
          session_id,
          task_id,
          relay_observation_id: -1,
          inherited_claims,
          rescue_reason,
        });
        continue;
      }

      const task = store.storage.getTask(task_id);
      const relay_observation_id = new TaskThread(store, task_id).relay({
        from_session_id: session_id,
        from_agent,
        reason: relayReason,
        one_line,
        base_branch: baseBranchFor(task),
        to_agent: 'any',
        expires_in_ms: RESCUE_RELAY_TTL_MS,
      });

      store.addObservation({
        session_id,
        kind: 'rescue-relay',
        task_id,
        content: `Rescue relay emitted for stranded session ${session_id}; dropped ${inherited_claims.length} claim(s).`,
        metadata: {
          stranded_session_id: session_id,
          last_observation_ts,
          last_tool_error: renderToolError(lastToolError),
          claim_count: inherited_claims.length,
          rescue_reason,
          relay_observation_id,
        },
      });

      outcome.rescued.push({
        session_id,
        task_id,
        relay_observation_id,
        inherited_claims,
        rescue_reason,
      });
    }
  }

  return outcome;
}

function groupClaimsByTask(store: MemoryStore, session_id: string): Map<number, TaskClaimRow[]> {
  const grouped = new Map<number, TaskClaimRow[]>();
  for (const task of store.storage.listTasks(1_000)) {
    const claims = store.storage
      .listClaims(task.id)
      .filter((claim) => claim.session_id === session_id);
    if (claims.length > 0) grouped.set(task.id, claims);
  }
  return grouped;
}

function candidateSessionId(candidate: StrandedSessionRow): string | undefined {
  const id = candidate.session_id ?? candidate.id;
  return typeof id === 'string' && id.trim() ? id : undefined;
}

function candidateRepoRoot(candidate: StrandedSessionRow): string | undefined {
  const root = candidate.repo_root ?? candidate.cwd;
  return typeof root === 'string' && root.trim() ? root : undefined;
}

function isLiveActiveSession(candidate: StrandedSessionRow, sessions: HivemindSession[]): boolean {
  const session_id = candidateSessionId(candidate);
  if (!session_id) return false;
  const candidateWorktree = normalizePath(candidate.worktree_path);
  return sessions.some((session) => {
    if (session.source !== 'active-session' || session.activity === 'dead') return false;
    if (session.session_key === session_id) return true;
    if (session.file_path.includes(session_id)) return true;
    if (candidateWorktree && normalizePath(session.worktree_path) === candidateWorktree) {
      return true;
    }
    return false;
  });
}

function latestToolError(
  storage: typeof MemoryStore.prototype.storage & RescueStorage,
  session_id: string,
  candidate: StrandedSessionRow,
): RecentToolErrorRow | null {
  const rows = recentToolErrors(storage, session_id);
  if (rows.length > 0) {
    return rows
      .slice()
      .sort((left, right) => numericTs(right.ts) - numericTs(left.ts))[0] as RecentToolErrorRow;
  }
  if (candidate.last_tool_error) {
    return { message: candidate.last_tool_error };
  }
  return null;
}

function recentToolErrors(storage: RescueStorage, session_id: string): RecentToolErrorRow[] {
  if (typeof storage.recentToolErrors !== 'function') return [];
  const reader = storage.recentToolErrors as (...args: unknown[]) => unknown;

  try {
    const objectRows = reader.call(storage, { session_id, limit: 5 });
    if (Array.isArray(objectRows) && objectRows.length > 0) {
      return objectRows.filter(isRecentToolError);
    }
  } catch {
    // Older storage signatures are handled below.
  }

  try {
    const positionalRows = reader.call(storage, session_id, 5);
    if (Array.isArray(positionalRows)) {
      return positionalRows.filter(isRecentToolError);
    }
  } catch {
    return [];
  }

  return [];
}

function rescueOneLine(store: MemoryStore, session_id: string): string {
  const recent = store.storage.timeline(session_id, undefined, 20);
  const row = recent.find((entry) => !isErrorObservation(entry));
  if (!row) return 'Stranded session - no recent activity, claims held';
  const [expanded] = store.getObservations([row.id], { expand: true });
  return truncateOneLine(expanded?.content ?? row.content);
}

function isErrorObservation(row: ObservationRow): boolean {
  const kind = row.kind.toLowerCase();
  return (
    kind.includes('error') ||
    kind === 'observer-note' ||
    kind === 'rescue-relay' ||
    kind === 'relay'
  );
}

function lastObservationTs(
  store: MemoryStore,
  session_id: string,
  candidate: StrandedSessionRow,
): number | null {
  const candidateTs = numericTs(candidate.last_observation_ts);
  if (candidateTs > 0) return candidateTs;
  return store.storage.timeline(session_id, undefined, 1)[0]?.ts ?? null;
}

function relayReasonFor(error: RecentToolErrorRow | null): RelayReason {
  return quotaText(error) ? 'quota' : 'unspecified';
}

function rescueReasonFor(error: RecentToolErrorRow | null): string {
  if (!error) return 'silent-stranded';
  if (quotaText(error)) return 'quota-rejection';
  return `last-error: ${toolName(error)}`;
}

function quotaText(error: RecentToolErrorRow | null): boolean {
  return error ? /quota/i.test(renderToolError(error) ?? '') : false;
}

function renderToolError(error: RecentToolErrorRow | null): string | null {
  if (!error) return null;
  const text = [toolName(error), error.message, error.error, error.content]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(': ');
  return text || null;
}

function toolName(error: RecentToolErrorRow): string {
  return error.tool ?? error.tool_name ?? error.name ?? 'unknown';
}

function isRecentToolError(value: unknown): value is RecentToolErrorRow {
  return Boolean(value && typeof value === 'object');
}

function inferAgent(session_id: string): string {
  const ide = inferIdeFromSessionId(session_id);
  if (ide === 'claude-code') return 'claude';
  if (ide) return ide;
  const parts = session_id.split(/[@\-:/_]/).filter(Boolean);
  if (parts[0] === 'agent' && parts[1]) return parts[1];
  return parts[0] ?? 'unknown';
}

function baseBranchFor(task: TaskRow | undefined): string {
  const branch = task?.branch.trim();
  if (!branch) return 'main';
  if (branch === 'main' || branch === 'master' || branch === 'dev') return branch;
  return 'main';
}

function truncateOneLine(input: string): string {
  const singleLine = input.replace(/\s+/g, ' ').trim();
  return singleLine.length > ONE_LINE_LIMIT ? singleLine.slice(0, ONE_LINE_LIMIT) : singleLine;
}

function normalizePath(path: string | null | undefined): string | undefined {
  return typeof path === 'string' && path.trim() ? path : undefined;
}

function numericTs(value: number | string | null | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Date.parse(value) || 0;
  }
  return 0;
}
