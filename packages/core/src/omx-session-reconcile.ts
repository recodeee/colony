import { type HivemindOptions, type HivemindSession, readActiveOmxSessions } from './hivemind.js';
import { inferSessionIdentity } from './infer-ide.js';
import type { MemoryStore } from './memory-store.js';

const INVALID_SESSION_KEYS = new Set(['null', 'undefined', 'unknown', 'unknown-session']);
const MAX_SESSION_KEY_LENGTH = 256;

export interface ReconcileOmxActiveSessionsOptions {
  repoRoot?: string;
  repoRoots?: string[];
  now?: number;
}

export interface ReconciledOmxActiveSession {
  id: string;
  ide: string;
  cwd: string | null;
  repo_root: string;
  branch: string;
  file_path: string;
}

export interface SkippedOmxActiveSession {
  file_path: string;
  reason: 'missing-stable-session-key';
}

export interface ReconcileOmxActiveSessionsResult {
  scanned: number;
  ensured: number;
  skipped: number;
  sessions: ReconciledOmxActiveSession[];
  skipped_sessions: SkippedOmxActiveSession[];
}

export function reconcileOmxActiveSessions(
  store: MemoryStore,
  options: ReconcileOmxActiveSessionsOptions = {},
): ReconcileOmxActiveSessionsResult {
  const hivemindOptions: HivemindOptions = {};
  if (options.repoRoot !== undefined) hivemindOptions.repoRoot = options.repoRoot;
  if (options.repoRoots !== undefined) hivemindOptions.repoRoots = options.repoRoots;
  if (options.now !== undefined) hivemindOptions.now = options.now;

  const activeSessions = readActiveOmxSessions(hivemindOptions);
  const sessions: ReconciledOmxActiveSession[] = [];
  const skippedSessions: SkippedOmxActiveSession[] = [];

  for (const session of activeSessions) {
    const id = stableSessionKey(session.session_key);
    if (!id) {
      skippedSessions.push({
        file_path: session.file_path,
        reason: 'missing-stable-session-key',
      });
      continue;
    }

    const ide = sessionIde(session, id);
    const cwd = session.worktree_path || session.repo_root || null;
    store.startSession({
      id,
      ide,
      cwd,
      startedAt: sessionStartedAt(session, options.now),
      metadata: sessionMetadata(session),
    });
    sessions.push({
      id,
      ide,
      cwd,
      repo_root: session.repo_root,
      branch: session.branch,
      file_path: session.file_path,
    });
  }

  return {
    scanned: activeSessions.length,
    ensured: sessions.length,
    skipped: skippedSessions.length,
    sessions,
    skipped_sessions: skippedSessions,
  };
}

function stableSessionKey(value: string): string | null {
  const key = value.trim();
  if (!key) return null;
  if (key.length > MAX_SESSION_KEY_LENGTH) return null;
  if (/[\0\r\n]/.test(key)) return null;
  if (INVALID_SESSION_KEYS.has(key.toLowerCase())) return null;
  return key;
}

function sessionIde(session: HivemindSession, sessionId: string): string {
  return inferSessionIdentity({
    sessionId,
    ide: session.cli,
    agent: session.agent,
    branch: session.branch,
    worktreePath: session.worktree_path,
    sourceHint: 'active-session',
  }).ide;
}

function sessionStartedAt(session: HivemindSession, fallbackNow = Date.now()): number {
  const parsed = Date.parse(session.started_at);
  return Number.isFinite(parsed) ? parsed : fallbackNow;
}

function sessionMetadata(session: HivemindSession): Record<string, unknown> {
  const identity = inferSessionIdentity({
    sessionId: session.session_key,
    ide: session.cli,
    agent: session.agent,
    branch: session.branch,
    worktreePath: session.worktree_path,
    sourceHint: 'active-session',
  });
  return compactMetadata({
    source: 'omx-active-session',
    inferred_agent: identity.inferred_agent,
    confidence: identity.confidence,
    identity_source: identity.source,
    cli: session.cli,
    agent: session.agent,
    repo_root: session.repo_root,
    branch: session.branch,
    worktree_path: session.worktree_path,
    task_name: session.task_name,
    latest_task_preview: session.latest_task_preview,
    last_heartbeat_at: session.last_heartbeat_at,
    active_session_file: session.file_path,
  });
}

function compactMetadata(input: Record<string, string | number>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) =>
      typeof value === 'string' ? value.trim() : Number.isFinite(value),
    ),
  );
}
