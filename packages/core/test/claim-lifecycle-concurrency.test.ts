/**
 * Concurrency-safety tests for the claim cleanup paths:
 *   - releaseExpiredQuotaClaims (TaskThread)
 *   - bulkRescueStrandedSessions (stranded-rescue)
 *
 * Both paths were previously structured as read-outside / write-inside DEFERRED
 * transactions, which allowed two callers to both read the same expired/stranded
 * claims and then both emit audit observations. The fix moves the read inside a
 * BEGIN IMMEDIATE transaction, so the second caller sees an already-processed
 * state and produces no duplicate observations.
 *
 * Within a single Node process better-sqlite3 is synchronous, so we can't
 * trigger a true cross-process write-lock race here. What these tests verify
 * is idempotency: calling the cleanup twice against unchanged data must not
 * produce duplicate audit records. That's the observable invariant that the
 * IMMEDIATE fix preserves.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import { bulkRescueStrandedSessions } from '../src/stranded-rescue.js';
import { TaskThread } from '../src/task-thread.js';

// ---------------------------------------------------------------------------
// Hivemind mock — bulkRescueStrandedSessions checks whether the session is
// live before touching it. We make the stranded session appear live so the
// rescue path proceeds.
// ---------------------------------------------------------------------------
const hivemind = vi.hoisted(() => ({
  sessions: [] as Array<{
    source: 'active-session';
    activity: 'working' | 'thinking' | 'idle' | 'stalled';
    session_key: string;
    file_path: string;
    worktree_path: string;
  }>,
}));

vi.mock('../src/hivemind.js', () => ({
  readHivemind: () => ({
    generated_at: new Date(0).toISOString(),
    repo_roots: ['/repo'],
    session_count: hivemind.sessions.length,
    counts: {},
    sessions: hivemind.sessions,
  }),
}));

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-claim-lifecycle-concurrency-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  hivemind.sessions = [];
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedSession(id: string): void {
  store.startSession({ id, ide: 'claude-code', cwd: '/repo' });
}

/**
 * Seeds a task with a quota-exhausted handoff so the owner's claim becomes
 * `handoff_pending` with a finite `expires_at`. We then call
 * `releaseExpiredQuotaClaims` with a `now` value far in the future so the
 * claim is treated as expired without needing to reach into the private `db`.
 */
function seedTaskWithPendingHandoffClaim(
  ownerSessionId: string,
  callerSessionId: string,
): { thread: TaskThread; handoffId: number } {
  const thread = TaskThread.open(store, {
    repo_root: '/repo',
    branch: 'feat/quota-test',
    session_id: ownerSessionId,
  });
  thread.join(ownerSessionId, 'claude');
  thread.join(callerSessionId, 'codex');
  thread.claimFile({ session_id: ownerSessionId, file_path: 'src/core.ts' });

  const handoffId = thread.handOff({
    from_session_id: ownerSessionId,
    from_agent: 'claude',
    to_agent: 'any',
    summary: 'quota exhausted',
    next_steps: ['take over'],
    reason: 'quota_exhausted',
    runtime_status: 'blocked_by_runtime_limit',
    quota_context: {
      agent: 'claude',
      session_id: ownerSessionId,
      repo_root: '/repo',
      branch: 'feat/quota-test',
      worktree_path: '/repo',
      task_id: thread.task_id,
      claimed_files: ['src/core.ts'],
      dirty_files: [],
      last_command: 'pnpm test',
      last_tool: 'Bash',
      last_verification: { command: 'pnpm test', result: 'blocked' },
      suggested_next_step: 'accept handoff',
      // Short TTL — claim will be expired when we pass now = Date.now() + FAR_FUTURE.
      handoff_ttl_ms: 1,
    },
  });

  return { thread, handoffId };
}

// A `now` value guaranteed to be past any handoff TTL set in this test.
const FAR_FUTURE = Date.now() + 100 * 24 * 60 * 60_000;

// ---------------------------------------------------------------------------
// releaseExpiredQuotaClaims — idempotency under repeated calls
// ---------------------------------------------------------------------------

describe('releaseExpiredQuotaClaims idempotency', () => {
  it('emits exactly one claim-weakened observation even when called twice', () => {
    const owner = 'claude-quota-owner';
    const caller = 'codex-quota-caller';
    seedSession(owner);
    seedSession(caller);

    const { thread, handoffId } = seedTaskWithPendingHandoffClaim(owner, caller);

    // First call — should release the expired claim and emit one audit obs.
    // We pass FAR_FUTURE as `now` so the handoff TTL is guaranteed to be past.
    const result1 = thread.releaseExpiredQuotaClaims({
      session_id: caller,
      now: FAR_FUTURE,
    });
    expect(result1.status).toBe('released_expired');
    expect(result1.released_claims).toHaveLength(1);
    expect(result1.released_claims[0]?.file_path).toBe('src/core.ts');

    const weakenedAfterFirst = store.storage
      .taskObservationsByKind(thread.task_id, 'claim-weakened')
      .filter((row) => {
        const meta = JSON.parse(row.metadata ?? '{}') as {
          handoff_observation_id?: number;
          reason?: string;
        };
        return meta.reason === 'quota_pending_expired' && meta.handoff_observation_id === handoffId;
      });
    expect(weakenedAfterFirst).toHaveLength(1);

    // Second call — claim is now weak_expired so the IMMEDIATE transaction's
    // re-read finds nothing eligible and emits no additional observations.
    const result2 = thread.releaseExpiredQuotaClaims({
      session_id: caller,
      now: FAR_FUTURE,
    });
    expect(result2.status).toBe('released_expired');
    expect(result2.released_claims).toHaveLength(0);

    // Still exactly one claim-weakened — no duplicate emitted.
    const weakenedAfterSecond = store.storage
      .taskObservationsByKind(thread.task_id, 'claim-weakened')
      .filter((row) => {
        const meta = JSON.parse(row.metadata ?? '{}') as {
          handoff_observation_id?: number;
          reason?: string;
        };
        return meta.reason === 'quota_pending_expired' && meta.handoff_observation_id === handoffId;
      });
    expect(weakenedAfterSecond).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// bulkRescueStrandedSessions — idempotency under repeated calls
// ---------------------------------------------------------------------------

type StrandedCandidate = {
  session_id: string;
  repo_root: string;
  worktree_path: string;
  last_observation_ts?: number;
};

function configureStrandedStorage(candidates: StrandedCandidate[]): void {
  (
    store.storage as typeof store.storage & {
      findStrandedSessions: (args: { stranded_after_ms: number }) => StrandedCandidate[];
    }
  ).findStrandedSessions = () => candidates;
}

describe('bulkRescueStrandedSessions idempotency', () => {
  it('emits exactly one rescue-stranded observation even when called twice', () => {
    const stranded = 'codex-stranded-session';
    seedSession(stranded);

    // Seed a task with a claim held by the stranded session.
    const owner = 'claude-owner';
    seedSession(owner);
    const thread = TaskThread.open(store, {
      repo_root: '/repo',
      branch: 'feat/rescue-test',
      session_id: owner,
    });
    thread.join(owner, 'claude');
    thread.join(stranded, 'codex');
    thread.claimFile({ session_id: stranded, file_path: 'src/stranded.ts' });

    // Add an observation so the session appears active in colony memory.
    store.addObservation({
      session_id: stranded,
      kind: 'note',
      task_id: thread.task_id,
      content: 'working on stranded feature',
    });

    configureStrandedStorage([
      {
        session_id: stranded,
        repo_root: '/repo',
        worktree_path: '/repo',
        last_observation_ts: Date.now() - 20 * 60_000,
      },
    ]);

    // First call — rescue should release the claim and emit one audit obs.
    const result1 = bulkRescueStrandedSessions(store, { dry_run: false });
    expect(result1.rescued).toHaveLength(1);
    expect(result1.rescued[0]?.session_id).toBe(stranded);
    expect(result1.released_claim_count).toBe(1);

    const rescueObsAfterFirst = store.storage
      .timeline(stranded, undefined, 50)
      .filter((row) => row.kind === 'rescue-stranded');
    expect(rescueObsAfterFirst).toHaveLength(1);

    // Second call — claim is already released; transaction sees no live claims.
    const result2 = bulkRescueStrandedSessions(store, { dry_run: false });
    // The session is reported as skipped (concurrent-already-released).
    const skippedOrRescuedCount = result2.skipped.length + result2.rescued.length;
    expect(skippedOrRescuedCount).toBeGreaterThan(0);

    // Still exactly one rescue-stranded observation — no duplicate emitted.
    const rescueObsAfterSecond = store.storage
      .timeline(stranded, undefined, 50)
      .filter((row) => row.kind === 'rescue-stranded');
    expect(rescueObsAfterSecond).toHaveLength(1);
  });
});
