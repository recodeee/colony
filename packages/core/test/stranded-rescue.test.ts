import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import { rescueStrandedSessions } from '../src/stranded-rescue.js';
import { TaskThread } from '../src/task-thread.js';

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

type StrandedCandidate = {
  session_id: string;
  repo_root: string;
  worktree_path: string;
  last_observation_ts?: number;
  last_tool_error?: string;
};

type ToolError = {
  tool?: string;
  message?: string;
  ts?: number;
};

type StrandedStorage = typeof MemoryStore.prototype.storage & {
  findStrandedSessions: ReturnType<
    typeof vi.fn<[{ stranded_after_ms: number }], StrandedCandidate[]>
  >;
  recentToolErrors: ReturnType<typeof vi.fn<[{ session_id: string; limit?: number }], ToolError[]>>;
};

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-stranded-rescue-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  hivemind.sessions = [];
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('rescueStrandedSessions', () => {
  it('reports an empty outcome when there are no stranded sessions', () => {
    configureStorage([]);

    expect(rescueStrandedSessions(store)).toEqual({
      scanned: 0,
      rescued: [],
      skipped: [],
    });
  });

  it('emits one relay, drops claims, and records rescue-relay audit metadata', () => {
    const { thread, session_id } = seedTask('feat/rescue', ['src/a.ts', 'src/b.ts']);
    store.addObservation({
      session_id,
      kind: 'note',
      task_id: thread.task_id,
      content: 'Replacing rescue storage adapter before quota cut.',
    });
    configureStorage([candidate(session_id)]);
    markAlive(session_id);

    const outcome = rescueStrandedSessions(store);

    expect(outcome.scanned).toBe(1);
    expect(outcome.rescued).toMatchObject([
      {
        session_id,
        task_id: thread.task_id,
        inherited_claims: ['src/a.ts', 'src/b.ts'],
        rescue_reason: 'silent-stranded',
      },
    ]);
    expect(store.storage.getClaim(thread.task_id, 'src/a.ts')).toBeUndefined();
    expect(store.storage.getClaim(thread.task_id, 'src/b.ts')).toBeUndefined();

    const rows = store.storage.taskTimeline(thread.task_id, 10);
    const relay = rows.find((row) => row.kind === 'relay');
    expect(relay?.id).toBe(outcome.rescued[0]?.relay_observation_id);
    const rescue = rows.find((row) => row.kind === 'rescue-relay');
    expect(JSON.parse(rescue?.metadata ?? '{}')).toMatchObject({
      stranded_session_id: session_id,
      claim_count: 2,
      rescue_reason: 'silent-stranded',
      relay_observation_id: relay?.id,
    });
    expect(rows.some((row) => row.kind === 'observer-note' && row.ts <= (rescue?.ts ?? 0))).toBe(
      true,
    );
  });

  it('emits one relay per task when a stranded session holds claims on multiple tasks', () => {
    const first = seedTask('feat/one', ['src/one.ts']);
    const second = seedTask('feat/two', ['src/two.ts']);
    configureStorage([candidate(first.session_id)]);
    markAlive(first.session_id);

    const outcome = rescueStrandedSessions(store);

    expect(outcome.rescued.map((entry) => entry.task_id).sort()).toEqual(
      [first.thread.task_id, second.thread.task_id].sort(),
    );
    expect(store.storage.getClaim(first.thread.task_id, 'src/one.ts')).toBeUndefined();
    expect(store.storage.getClaim(second.thread.task_id, 'src/two.ts')).toBeUndefined();
  });

  it('uses quota relay reason when the latest tool error matches quota', () => {
    const { session_id } = seedTask('feat/quota', ['src/quota.ts']);
    configureStorage([candidate(session_id)], [{ tool: 'Bash', message: 'quota exceeded', ts: 2 }]);
    markAlive(session_id);

    const outcome = rescueStrandedSessions(store);
    const relay = store.storage.getObservation(outcome.rescued[0]?.relay_observation_id ?? -1);
    const relayMeta = JSON.parse(relay?.metadata ?? '{}') as { reason?: string };

    expect(relayMeta.reason).toBe('quota');
    expect(outcome.rescued[0]?.rescue_reason).toBe('quota-rejection');
  });

  it('dry_run plans rescue without emitting relays or dropping claims', () => {
    const { thread, session_id } = seedTask('feat/dry-run', ['src/dry.ts']);
    configureStorage([candidate(session_id)]);
    markAlive(session_id);

    const outcome = rescueStrandedSessions(store, { dry_run: true });

    expect(outcome.rescued).toMatchObject([
      {
        session_id,
        task_id: thread.task_id,
        relay_observation_id: -1,
        inherited_claims: ['src/dry.ts'],
      },
    ]);
    expect(store.storage.getClaim(thread.task_id, 'src/dry.ts')?.session_id).toBe(session_id);
    expect(store.storage.taskTimeline(thread.task_id, 10).some((row) => row.kind === 'relay')).toBe(
      false,
    );
    expect(
      store.storage.taskTimeline(thread.task_id, 10).some((row) => row.kind === 'rescue-relay'),
    ).toBe(false);
  });

  it('skips stranded candidates that are no longer alive in readHivemind', () => {
    const { thread, session_id } = seedTask('feat/dead', ['src/dead.ts']);
    configureStorage([candidate(session_id)]);

    const outcome = rescueStrandedSessions(store);

    expect(outcome.rescued).toEqual([]);
    expect(outcome.skipped).toEqual([{ session_id, reason: 'session not alive' }]);
    expect(store.storage.getClaim(thread.task_id, 'src/dead.ts')?.session_id).toBe(session_id);
  });
});

function seedTask(branch: string, files: string[]): { thread: TaskThread; session_id: string } {
  const session_id = 'codex-stranded-session';
  store.startSession({ id: session_id, ide: 'codex', cwd: '/repo' });
  const thread = TaskThread.open(store, {
    repo_root: '/repo',
    branch,
    session_id,
  });
  thread.join(session_id, 'codex');
  for (const file_path of files) {
    thread.claimFile({ session_id, file_path });
  }
  return { thread, session_id };
}

function configureStorage(candidates: StrandedCandidate[], errors: ToolError[] = []): void {
  const storage = store.storage as StrandedStorage;
  storage.findStrandedSessions = vi.fn(() => candidates);
  storage.recentToolErrors = vi.fn(() => errors);
}

function candidate(session_id: string): StrandedCandidate {
  return {
    session_id,
    repo_root: '/repo',
    worktree_path: `/repo/.omx/agent-worktrees/${session_id}`,
    last_observation_ts: 123,
  };
}

function markAlive(session_id: string): void {
  hivemind.sessions = [
    {
      source: 'active-session',
      activity: 'working',
      session_key: session_id,
      file_path: `/repo/.omx/state/active-sessions/${session_id}.json`,
      worktree_path: `/repo/.omx/agent-worktrees/${session_id}`,
    },
  ];
}
