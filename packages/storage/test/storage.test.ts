import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTECTED_BRANCH_NAMES, Storage, isProtectedBranch } from '../src/index.js';

let dir: string;
let storage: Storage;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-'));
  storage = new Storage(join(dir, 'test.db'));
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Storage', () => {
  it('fills orphan session cwd and ide when richer hook payload arrives', () => {
    storage.createSession({
      id: 'codex@abc',
      ide: 'unknown',
      cwd: null,
      started_at: 100,
      metadata: null,
    });
    storage.createSession({
      id: 'codex@abc',
      ide: 'codex',
      cwd: '/repo',
      started_at: 200,
      metadata: JSON.stringify({ source: 'hook' }),
    });

    const row = storage.getSession('codex@abc');
    expect(row).toMatchObject({
      id: 'codex@abc',
      ide: 'codex',
      cwd: '/repo',
      started_at: 100,
      ended_at: null,
    });
    expect(row?.metadata).toBe(JSON.stringify({ source: 'hook' }));
  });

  it('preserves known session cwd and ide on weaker duplicate payloads', () => {
    storage.createSession({
      id: 'codex@known',
      ide: 'codex',
      cwd: '/repo',
      started_at: 100,
      metadata: null,
    });
    storage.createSession({
      id: 'codex@known',
      ide: 'unknown',
      cwd: null,
      started_at: 200,
      metadata: null,
    });

    expect(storage.getSession('codex@known')).toMatchObject({
      ide: 'codex',
      cwd: '/repo',
      started_at: 100,
    });
  });

  it('stores and retrieves observations', () => {
    storage.createSession({
      id: 'sess-1',
      ide: 'claude-code',
      cwd: '/tmp',
      started_at: Date.now(),
      metadata: null,
    });
    const id = storage.insertObservation({
      session_id: 'sess-1',
      kind: 'note',
      content: 'db config updated',
      compressed: true,
      intensity: 'full',
    });
    const rows = storage.getObservations([id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.compressed).toBe(1);
  });

  it('stores lane pause and resume state', () => {
    storage.setLaneState({
      session_id: 'codex@lane',
      state: 'paused',
      updated_by_session_id: 'human:ops',
      reason: 'manual contention check',
      updated_at: 1000,
    });

    expect(storage.getLaneState('codex@lane')).toMatchObject({
      session_id: 'codex@lane',
      state: 'paused',
      reason: 'manual contention check',
      updated_at: 1000,
      updated_by_session_id: 'human:ops',
    });
    expect(storage.listPausedLanes()).toEqual([
      expect.objectContaining({
        session_id: 'codex@lane',
        state: 'paused',
        reason: 'manual contention check',
      }),
    ]);

    storage.setLaneState({
      session_id: 'codex@lane',
      state: 'active',
      updated_by_session_id: 'human:ops',
      reason: 'owner returned',
      updated_at: 2000,
    });

    expect(storage.getLaneState('codex@lane')).toMatchObject({
      state: 'active',
      reason: 'owner returned',
      updated_at: 2000,
    });
    expect(storage.listPausedLanes()).toHaveLength(0);
  });

  it('takes over a contended lane claim with weak-old-claim audit', () => {
    storage.createSession({
      id: 'codex@old',
      ide: 'codex',
      cwd: '/repo',
      started_at: 100,
      metadata: null,
    });
    storage.createSession({
      id: 'codex@new',
      ide: 'codex',
      cwd: '/repo',
      started_at: 100,
      metadata: null,
    });
    const task = storage.findOrCreateTask({
      title: 'contended lane',
      repo_root: '/repo',
      branch: 'agent/codex/contention',
      created_by: 'codex@old',
    });
    storage.addTaskParticipant({ task_id: task.id, session_id: 'codex@old', agent: 'codex' });
    storage.claimFile({ task_id: task.id, file_path: 'src/shared.ts', session_id: 'codex@old' });

    const result = storage.takeOverLaneClaim({
      target_session_id: 'codex@old',
      requester_session_id: 'codex@new',
      requester_agent: 'codex',
      file_path: 'src/shared.ts',
      reason: 'old lane paused by human',
      now: 2000,
    });

    expect(result).toMatchObject({
      task_id: task.id,
      file_path: 'src/shared.ts',
      previous_session_id: 'codex@old',
      assigned_session_id: 'codex@new',
    });
    expect(storage.getClaim(task.id, 'src/shared.ts')?.session_id).toBe('codex@new');
    const weakened = storage.taskObservationsByKind(task.id, 'claim-weakened');
    expect(weakened[0]?.session_id).toBe('codex@old');
    expect(JSON.parse(weakened[0]?.metadata ?? '{}')).toMatchObject({
      ownership_strength: 'weak',
      assigned_session_id: 'codex@new',
      reason: 'old lane paused by human',
    });
    const takeover = storage.taskObservationsByKind(task.id, 'lane-takeover');
    expect(takeover[0]?.id).toBe(result.takeover_observation_id);
    expect(JSON.parse(takeover[0]?.metadata ?? '{}')).toMatchObject({
      target_session_id: 'codex@old',
      file_path: 'src/shared.ts',
      weakened_observation_id: result.weakened_observation_id,
    });
  });

  it('returns recent observations across sessions in descending order', () => {
    storage.createSession({
      id: 'sess-a',
      ide: 'codex',
      cwd: '/repo',
      started_at: 100,
      metadata: null,
    });
    storage.createSession({
      id: 'sess-b',
      ide: 'claude-code',
      cwd: '/repo',
      started_at: 100,
      metadata: null,
    });
    storage.insertObservation({
      session_id: 'sess-a',
      kind: 'note',
      content: 'oldest',
      compressed: false,
      intensity: null,
      ts: 1000,
    });
    storage.insertObservation({
      session_id: 'sess-b',
      kind: 'handoff',
      content: 'same ts lower id',
      compressed: false,
      intensity: null,
      ts: 3000,
    });
    storage.insertObservation({
      session_id: 'sess-a',
      kind: 'note',
      content: 'same ts higher id',
      compressed: false,
      intensity: null,
      ts: 3000,
    });
    storage.insertObservation({
      session_id: 'sess-b',
      kind: 'tool_use',
      content: 'middle',
      compressed: false,
      intensity: null,
      ts: 2000,
    });

    const rows = storage.recentObservations(4);

    expect(
      rows.map(({ session_id, kind, content, ts }) => ({ session_id, kind, content, ts })),
    ).toEqual([
      { session_id: 'sess-a', kind: 'note', content: 'same ts higher id', ts: 3000 },
      { session_id: 'sess-b', kind: 'handoff', content: 'same ts lower id', ts: 3000 },
      { session_id: 'sess-b', kind: 'tool_use', content: 'middle', ts: 2000 },
      { session_id: 'sess-a', kind: 'note', content: 'oldest', ts: 1000 },
    ]);
  });

  it('FTS search finds matches', () => {
    storage.createSession({
      id: 's',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    storage.insertObservation({
      session_id: 's',
      kind: 'note',
      content: 'auth middleware throws 401',
      compressed: true,
      intensity: 'full',
    });
    const hits = storage.searchFts('auth');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.snippet).toContain('[auth]');
  });

  it('FTS search expands short prefixes across path-like terms', () => {
    storage.createSession({
      id: 's-prefix',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    storage.insertObservation({
      session_id: 's-prefix',
      kind: 'tool_use',
      content: 'edited packages/storage/src/storage.ts searchFts implementation',
      compressed: true,
      intensity: 'full',
    });

    const hits = storage.searchFts('stor searchf');
    expect(hits[0]?.session_id).toBe('s-prefix');
  });

  it('FTS search falls back to fuzzy matching for transposed query terms', () => {
    storage.createSession({
      id: 's-fuzzy',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    storage.insertObservation({
      session_id: 's-fuzzy',
      kind: 'note',
      content: 'search command indexes observations',
      compressed: true,
      intensity: 'full',
    });

    const hits = storage.searchFts('saerch command');
    expect(hits[0]?.session_id).toBe('s-fuzzy');
  });

  it('rebuildFts leaves FTS queryable', () => {
    storage.createSession({
      id: 'sfts',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    storage.insertObservation({
      session_id: 'sfts',
      kind: 'note',
      content: 'token bucket rate limiter',
      compressed: true,
      intensity: 'full',
    });
    expect(() => storage.rebuildFts()).not.toThrow();
    const hits = storage.searchFts('bucket');
    expect(hits.length).toBeGreaterThan(0);
  });

  it('stores and retrieves embeddings', () => {
    storage.createSession({
      id: 's2',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    const id = storage.insertObservation({
      session_id: 's2',
      kind: 'note',
      content: 'x',
      compressed: true,
      intensity: 'full',
    });
    const vec = new Float32Array([0.1, 0.2, 0.3]);
    storage.putEmbedding(id, 'test-model', vec);
    const got = storage.getEmbedding(id);
    expect(got?.dim).toBe(3);
    expect(Array.from(got?.vec)).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
      expect.closeTo(0.3, 5),
    ]);
  });

  it('allEmbeddings filters by model + dim', () => {
    storage.createSession({
      id: 's3',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        storage.insertObservation({
          session_id: 's3',
          kind: 'note',
          content: `n${i}`,
          compressed: true,
          intensity: 'full',
        }),
      );
    }
    storage.putEmbedding(ids[0] as number, 'old-model', new Float32Array([1, 2]));
    storage.putEmbedding(ids[1] as number, 'new-model', new Float32Array([1, 2, 3]));
    storage.putEmbedding(ids[2] as number, 'new-model', new Float32Array([4, 5, 6]));

    expect(storage.allEmbeddings().length).toBe(3);
    expect(storage.allEmbeddings({ model: 'new-model', dim: 3 }).length).toBe(2);
    expect(storage.allEmbeddings({ model: 'old-model', dim: 2 }).length).toBe(1);
    expect(storage.allEmbeddings({ model: 'new-model', dim: 2 }).length).toBe(0);
  });

  it('embeddingsForObservations filters by observation ids and model shape', () => {
    storage.createSession({
      id: 's3-candidates',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(
        storage.insertObservation({
          session_id: 's3-candidates',
          kind: 'note',
          content: `candidate-${i}`,
          compressed: true,
          intensity: 'full',
        }),
      );
    }
    storage.putEmbedding(ids[0] as number, 'old-model', new Float32Array([1, 2]));
    storage.putEmbedding(ids[1] as number, 'new-model', new Float32Array([1, 2, 3]));
    storage.putEmbedding(ids[2] as number, 'new-model', new Float32Array([4, 5, 6]));
    storage.putEmbedding(ids[3] as number, 'new-model', new Float32Array([7, 8]));

    const hits = storage.embeddingsForObservations([ids[1] as number, ids[2] as number], {
      model: 'new-model',
      dim: 3,
    });
    expect(hits.map((hit) => hit.observation_id).sort()).toEqual([ids[1], ids[2]].sort());
    expect(
      storage.embeddingsForObservations([ids[0] as number], { model: 'new-model', dim: 3 }).length,
    ).toBe(0);
  });

  it('dropEmbeddingsWhereModelNot clears stale rows', () => {
    storage.createSession({
      id: 's4',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    const a = storage.insertObservation({
      session_id: 's4',
      kind: 'note',
      content: 'a',
      compressed: true,
      intensity: 'full',
    });
    const b = storage.insertObservation({
      session_id: 's4',
      kind: 'note',
      content: 'b',
      compressed: true,
      intensity: 'full',
    });
    storage.putEmbedding(a, 'old-model', new Float32Array([1]));
    storage.putEmbedding(b, 'new-model', new Float32Array([1]));

    const dropped = storage.dropEmbeddingsWhereModelNot('new-model');
    expect(dropped).toBe(1);
    expect(storage.allEmbeddings().length).toBe(1);
  });

  it('observationsMissingEmbeddings respects the model filter', () => {
    storage.createSession({
      id: 's5',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        storage.insertObservation({
          session_id: 's5',
          kind: 'note',
          content: `n${i}`,
          compressed: true,
          intensity: 'full',
        }),
      );
    }
    storage.putEmbedding(ids[0] as number, 'model-a', new Float32Array([1]));

    // No filter: only ids[0] has an embedding at all, so ids[1] and ids[2] are missing.
    expect(
      storage
        .observationsMissingEmbeddings(10)
        .map((r) => r.id)
        .sort(),
    ).toEqual([ids[1], ids[2]].sort());
    // Filter to model-b: ids[0] has no model-b embedding, so all 3 are missing.
    expect(
      storage
        .observationsMissingEmbeddings(10, 'model-b')
        .map((r) => r.id)
        .sort(),
    ).toEqual([ids[0], ids[1], ids[2]].sort());
  });

  it('observationsMissingEmbeddingsAfter scans only new observation ids', () => {
    storage.createSession({
      id: 's5-after',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(
        storage.insertObservation({
          session_id: 's5-after',
          kind: 'note',
          content: `n${i}`,
          compressed: true,
          intensity: 'full',
        }),
      );
    }
    storage.putEmbedding(ids[2] as number, 'model-a', new Float32Array([1]));

    expect(storage.lastObservationId()).toBe(ids[3]);
    expect(
      storage.observationsMissingEmbeddingsAfter(ids[0] as number, 10, 'model-a').map((r) => r.id),
    ).toEqual([ids[1], ids[3]]);
  });

  it('countObservations + countEmbeddings return correct totals', () => {
    storage.createSession({
      id: 's6',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    expect(storage.countObservations()).toBe(0);
    const id = storage.insertObservation({
      session_id: 's6',
      kind: 'note',
      content: 'a',
      compressed: true,
      intensity: 'full',
    });
    expect(storage.countObservations()).toBe(1);
    expect(storage.countEmbeddings()).toBe(0);
    storage.putEmbedding(id, 'm', new Float32Array([1]));
    expect(storage.countEmbeddings()).toBe(1);
    expect(storage.countEmbeddings({ model: 'm', dim: 1 })).toBe(1);
    expect(storage.countEmbeddings({ model: 'm', dim: 2 })).toBe(0);
  });

  it('backfillUnknownIde only rewrites rows the mapper can classify', () => {
    storage.createSession({
      id: 'codex-foo',
      ide: 'unknown',
      cwd: null,
      started_at: 1,
      metadata: null,
    });
    storage.createSession({
      id: 'agent/codex/bar',
      ide: 'unknown',
      cwd: null,
      started_at: 2,
      metadata: null,
    });
    storage.createSession({
      id: 'mystery-slug',
      ide: 'unknown',
      cwd: null,
      started_at: 3,
      metadata: null,
    });
    storage.createSession({
      id: 'known-session',
      ide: 'claude-code',
      cwd: null,
      started_at: 4,
      metadata: null,
    });

    const mapper = (id: string): string | undefined => {
      if (id.startsWith('codex-')) return 'codex';
      if (id.startsWith('agent/codex/')) return 'codex';
      return undefined;
    };
    const result = storage.backfillUnknownIde(mapper);
    expect(result).toEqual({ scanned: 3, updated: 2 });

    expect(storage.getSession('codex-foo')?.ide).toBe('codex');
    expect(storage.getSession('agent/codex/bar')?.ide).toBe('codex');
    expect(storage.getSession('mystery-slug')?.ide).toBe('unknown');
    expect(storage.getSession('known-session')?.ide).toBe('claude-code');

    // Idempotent: running again should not touch anything.
    expect(storage.backfillUnknownIde(mapper)).toEqual({ scanned: 1, updated: 0 });
  });

  it('toolInvocationDistribution counts tool_use rows by metadata.tool, sorted desc, windowed', () => {
    storage.createSession({
      id: 'sess-tool-dist',
      ide: 'claude-code',
      cwd: null,
      started_at: 1,
      metadata: null,
    });
    const tools: Array<{ tool: string; count: number; ts: number }> = [
      { tool: 'Bash', count: 5, ts: 2_000 },
      { tool: 'Edit', count: 3, ts: 2_000 },
      { tool: 'mcp__colony__task_post', count: 2, ts: 2_000 },
      { tool: 'old-tool-out-of-window', count: 4, ts: 100 },
    ];
    for (const t of tools) {
      for (let i = 0; i < t.count; i++) {
        storage.insertObservation({
          session_id: 'sess-tool-dist',
          kind: 'tool_use',
          content: `${t.tool} call ${i}`,
          compressed: false,
          intensity: null,
          ts: t.ts,
          metadata: { tool: t.tool },
        });
      }
    }
    storage.insertObservation({
      session_id: 'sess-tool-dist',
      kind: 'note',
      content: 'not a tool_use, must be excluded',
      compressed: false,
      intensity: null,
      ts: 2_000,
      metadata: { tool: 'Bash' },
    });

    const rows = storage.toolInvocationDistribution(1_000);
    expect(rows).toEqual([
      { tool: 'Bash', count: 5 },
      { tool: 'Edit', count: 3 },
      { tool: 'mcp__colony__task_post', count: 2 },
    ]);

    const limited = storage.toolInvocationDistribution(1_000, 2);
    expect(limited).toHaveLength(2);
    expect(limited[0]?.tool).toBe('Bash');
  });

  it('claimCoverageSnapshot counts claim kinds and Edit/Write tool uses in SQL', () => {
    storage.createSession({
      id: 'sess-claim-coverage',
      ide: 'codex',
      cwd: null,
      started_at: 1,
      metadata: null,
    });
    const observedKinds = [
      { kind: 'tool_use', content: 'edit', metadata: { tool: 'Edit' } },
      { kind: 'tool_use', content: 'write', metadata: { tool: 'Write' } },
      { kind: 'tool_use', content: 'read', metadata: { tool: 'Read' } },
      { kind: 'auto-claim', content: 'auto', metadata: { source: 'post-tool-use' } },
      { kind: 'claim', content: 'claim', metadata: { file_path: 'src/a.ts' } },
      { kind: 'claim-conflict', content: 'conflict', metadata: { file_path: 'src/b.ts' } },
      { kind: 'git-op', content: 'git checkout', metadata: { tool: 'Bash' } },
      { kind: 'file-op', content: 'mv src/a.ts src/b.ts', metadata: { tool: 'Bash' } },
    ];
    for (const row of observedKinds) {
      storage.insertObservation({
        session_id: 'sess-claim-coverage',
        kind: row.kind,
        content: row.content,
        compressed: false,
        intensity: null,
        ts: 2_000,
        metadata: row.metadata,
      });
    }
    storage.insertObservation({
      session_id: 'sess-claim-coverage',
      kind: 'tool_use',
      content: 'old edit',
      compressed: false,
      intensity: null,
      ts: 100,
      metadata: { tool: 'Edit' },
    });

    const snapshot = storage.claimCoverageSnapshot(1_000);
    expect(snapshot).toMatchObject({
      since: 1_000,
      edit_write_count: 2,
      auto_claim_count: 1,
      explicit_claim_count: 1,
      claim_conflict_count: 1,
      bash_git_op_count: 1,
      bash_file_op_count: 1,
      bash_git_file_op_count: 2,
    });
    expect(snapshot.until).toBeGreaterThanOrEqual(snapshot.since);
  });

  it('pendingHandoffs excludes expired rows without deleting audit records', () => {
    storage.createSession({
      id: 'claude',
      ide: 'claude-code',
      cwd: '/repo',
      started_at: 1,
      metadata: null,
    });
    const task = storage.findOrCreateTask({
      title: 'handoff decay',
      repo_root: '/repo',
      branch: 'feat/handoff-decay',
      created_by: 'claude',
    });
    const now = Date.now();
    const liveId = storage.insertObservation({
      session_id: 'claude',
      kind: 'handoff',
      content: 'live',
      compressed: false,
      intensity: null,
      ts: now,
      task_id: task.id,
      reply_to: null,
      metadata: {
        kind: 'handoff',
        status: 'pending',
        expires_at: now + 60_000,
      },
    });
    const expiredId = storage.insertObservation({
      session_id: 'claude',
      kind: 'handoff',
      content: 'expired',
      compressed: false,
      intensity: null,
      ts: now,
      task_id: task.id,
      reply_to: null,
      metadata: {
        kind: 'handoff',
        status: 'pending',
        expires_at: now - 1000,
      },
    });
    const legacyExpiredId = storage.insertObservation({
      session_id: 'claude',
      kind: 'handoff',
      content: 'legacy expired',
      compressed: false,
      intensity: null,
      ts: now - 3 * 60 * 60_000,
      task_id: task.id,
      reply_to: null,
      metadata: {
        kind: 'handoff',
        status: 'pending',
      },
    });

    expect(storage.pendingHandoffs(task.id).map((row) => row.id)).toEqual([liveId]);
    expect(storage.getObservation(expiredId)).toBeDefined();
    expect(storage.getObservation(legacyExpiredId)).toBeDefined();
  });
});

describe('isProtectedBranch', () => {
  it('returns true for canonical protected base branches', () => {
    expect(isProtectedBranch('main')).toBe(true);
    expect(isProtectedBranch('master')).toBe(true);
    expect(isProtectedBranch('dev')).toBe(true);
    expect(isProtectedBranch('develop')).toBe(true);
    expect(isProtectedBranch('production')).toBe(true);
    expect(isProtectedBranch('release')).toBe(true);
  });

  it('normalizes case and surrounding whitespace before lookup', () => {
    expect(isProtectedBranch('  Main  ')).toBe(true);
    expect(isProtectedBranch('MASTER')).toBe(true);
    expect(isProtectedBranch('Dev')).toBe(true);
  });

  it('returns false for agent branches and unknown names', () => {
    expect(isProtectedBranch('agent/claude/health-fix')).toBe(false);
    expect(isProtectedBranch('feature/x')).toBe(false);
    expect(isProtectedBranch('main-fork')).toBe(false);
    expect(isProtectedBranch('')).toBe(false);
    expect(isProtectedBranch('   ')).toBe(false);
    expect(isProtectedBranch(null)).toBe(false);
    expect(isProtectedBranch(undefined)).toBe(false);
  });

  it('exposes the protected set as a frozen lookup', () => {
    expect(PROTECTED_BRANCH_NAMES.has('main')).toBe(true);
    expect(PROTECTED_BRANCH_NAMES.has('agent/claude/x')).toBe(false);
  });
});

describe('Storage.sweepStaleClaims', () => {
  let dir: string;
  let storage: Storage;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'colony-sweep-'));
    storage = new Storage(join(dir, 'test.db'));
  });
  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('demotes active claims older than the cutoff and leaves fresh ones alone', () => {
    storage.createSession({
      id: 'sess-old',
      ide: 'claude-code',
      cwd: '/repo',
      started_at: 0,
      metadata: null,
    });
    storage.createSession({
      id: 'sess-new',
      ide: 'claude-code',
      cwd: '/repo',
      started_at: 0,
      metadata: null,
    });
    const task = storage.findOrCreateTask({
      title: 'sweep-target',
      repo_root: '/repo',
      branch: 'agent/claude/sweep',
      created_by: 'sess-old',
    });
    storage.claimFile({ task_id: task.id, file_path: 'src/old.ts', session_id: 'sess-old' });
    storage.claimFile({ task_id: task.id, file_path: 'src/new.ts', session_id: 'sess-new' });

    const oldClaim = storage.getClaim(task.id, 'src/old.ts');
    expect(oldClaim?.state).toBe('active');
    const claimedAt = oldClaim?.claimed_at ?? 0;
    const now = claimedAt + 5 * 60_000;
    const result = storage.sweepStaleClaims({ stale_after_ms: 60_000, now });

    expect(result.swept).toBe(2);
    expect(result.demoted.map((c) => c.file_path).sort()).toEqual(['src/new.ts', 'src/old.ts']);
    expect(storage.getClaim(task.id, 'src/old.ts')?.state).toBe('weak_expired');
    expect(storage.getClaim(task.id, 'src/new.ts')?.state).toBe('weak_expired');
  });

  it('skips claims younger than stale_after_ms', () => {
    storage.createSession({
      id: 'sess-fresh',
      ide: 'claude-code',
      cwd: '/repo',
      started_at: 0,
      metadata: null,
    });
    const task = storage.findOrCreateTask({
      title: 'fresh-target',
      repo_root: '/repo',
      branch: 'agent/claude/fresh',
      created_by: 'sess-fresh',
    });
    storage.claimFile({ task_id: task.id, file_path: 'src/fresh.ts', session_id: 'sess-fresh' });
    const claimedAt = storage.getClaim(task.id, 'src/fresh.ts')?.claimed_at ?? 0;
    const now = claimedAt + 30_000;
    const result = storage.sweepStaleClaims({ stale_after_ms: 60_000, now });

    expect(result.swept).toBe(0);
    expect(result.demoted).toEqual([]);
    expect(storage.getClaim(task.id, 'src/fresh.ts')?.state).toBe('active');
  });

  it('does not redemote already-weak claims', () => {
    storage.createSession({
      id: 'sess-weak',
      ide: 'claude-code',
      cwd: '/repo',
      started_at: 0,
      metadata: null,
    });
    const task = storage.findOrCreateTask({
      title: 'weak-target',
      repo_root: '/repo',
      branch: 'agent/claude/weak',
      created_by: 'sess-weak',
    });
    storage.claimFile({ task_id: task.id, file_path: 'src/already.ts', session_id: 'sess-weak' });
    const handoffId = storage.insertObservation({
      session_id: 'sess-weak',
      kind: 'handoff',
      content: 'h',
      compressed: false,
      intensity: null,
      ts: 0,
      task_id: task.id,
      reply_to: null,
      metadata: { kind: 'handoff', status: 'pending' },
    });
    storage.markClaimHandoffPending({
      task_id: task.id,
      file_path: 'src/already.ts',
      session_id: 'sess-weak',
      expires_at: 0,
      handoff_observation_id: handoffId,
    });
    storage.markClaimWeakExpired({
      task_id: task.id,
      file_path: 'src/already.ts',
      session_id: 'sess-weak',
      handoff_observation_id: handoffId,
    });
    expect(storage.getClaim(task.id, 'src/already.ts')?.state).toBe('weak_expired');

    const claimedAt = storage.getClaim(task.id, 'src/already.ts')?.claimed_at ?? 0;
    const result = storage.sweepStaleClaims({
      stale_after_ms: 1,
      now: claimedAt + 60 * 60_000,
    });
    expect(result.swept).toBe(0);
    expect(storage.getClaim(task.id, 'src/already.ts')?.state).toBe('weak_expired');
  });

  it('respects the limit option for bounded sweeps', () => {
    storage.createSession({
      id: 'sess-many',
      ide: 'claude-code',
      cwd: '/repo',
      started_at: 0,
      metadata: null,
    });
    const task = storage.findOrCreateTask({
      title: 'many-target',
      repo_root: '/repo',
      branch: 'agent/claude/many',
      created_by: 'sess-many',
    });
    for (let i = 0; i < 5; i++) {
      storage.claimFile({
        task_id: task.id,
        file_path: `src/file-${i}.ts`,
        session_id: 'sess-many',
      });
    }
    const result = storage.sweepStaleClaims({
      stale_after_ms: 0,
      now: Date.now() + 60 * 60_000,
      limit: 2,
    });
    expect(result.swept).toBe(2);
    expect(result.demoted).toHaveLength(2);
  });
});

describe('Storage.findCompletedQueenPlans', () => {
  let dir: string;
  let storage: Storage;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'colony-plans-'));
    storage = new Storage(join(dir, 'test.db'));
    storage.createSession({
      id: 'planner',
      ide: 'claude-code',
      cwd: '/repo',
      started_at: 0,
      metadata: null,
    });
  });
  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function makePlan(slug: string, subStatuses: Array<'available' | 'claimed' | 'completed'>) {
    const parent = storage.findOrCreateTask({
      title: `parent-${slug}`,
      repo_root: '/repo',
      branch: `spec/${slug}`,
      created_by: 'planner',
    });
    const subTaskIds: number[] = [];
    subStatuses.forEach((status, idx) => {
      const sub = storage.findOrCreateTask({
        title: `${slug}-sub-${idx}`,
        repo_root: '/repo',
        branch: `spec/${slug}/sub-${idx}`,
        created_by: 'planner',
      });
      subTaskIds.push(sub.id);
      storage.insertObservation({
        session_id: 'planner',
        kind: 'plan-subtask-claim',
        content: `${slug} sub-${idx} ${status}`,
        compressed: false,
        intensity: null,
        ts: Date.now() + idx,
        task_id: sub.id,
        reply_to: null,
        metadata: { kind: 'plan-subtask-claim', status },
      });
    });
    return { parent, subTaskIds };
  }

  it('returns plans whose every sub-task latest claim is completed', () => {
    makePlan('done-plan', ['completed', 'completed']);
    const result = storage.findCompletedQueenPlans('/repo');
    expect(result).toHaveLength(1);
    expect(result[0]?.plan_slug).toBe('done-plan');
    expect(result[0]?.subtask_count).toBe(2);
  });

  it('excludes plans with at least one non-completed sub-task', () => {
    makePlan('partial-plan', ['completed', 'claimed']);
    expect(storage.findCompletedQueenPlans('/repo')).toEqual([]);
  });

  it('respects the latest claim observation when status changes over time', () => {
    const { subTaskIds } = makePlan('progressive-plan', ['claimed']);
    const [subTaskId] = subTaskIds;
    if (subTaskId === undefined) {
      throw new Error('expected progressive-plan to create a sub-task');
    }
    storage.insertObservation({
      session_id: 'planner',
      kind: 'plan-subtask-claim',
      content: 'progressive-plan sub-0 completed',
      compressed: false,
      intensity: null,
      ts: Date.now() + 1000,
      task_id: subTaskId,
      reply_to: null,
      metadata: { kind: 'plan-subtask-claim', status: 'completed' },
    });
    const result = storage.findCompletedQueenPlans('/repo');
    expect(result.map((r) => r.plan_slug)).toEqual(['progressive-plan']);
  });

  it('excludes plans whose parent is already archived', () => {
    makePlan('already-archived', ['completed']);
    storage.archiveQueenPlan({ repo_root: '/repo', plan_slug: 'already-archived' });
    expect(storage.findCompletedQueenPlans('/repo')).toEqual([]);
  });

  it('excludes plans without a parent row', () => {
    const orphan = storage.findOrCreateTask({
      title: 'orphan-sub',
      repo_root: '/repo',
      branch: 'spec/orphan/sub-0',
      created_by: 'planner',
    });
    storage.insertObservation({
      session_id: 'planner',
      kind: 'plan-subtask-claim',
      content: 'orphan sub-0 completed',
      compressed: false,
      intensity: null,
      ts: Date.now(),
      task_id: orphan.id,
      reply_to: null,
      metadata: { kind: 'plan-subtask-claim', status: 'completed' },
    });
    expect(storage.findCompletedQueenPlans('/repo')).toEqual([]);
  });

  it('filters by repo_root when provided', () => {
    makePlan('repo-a-plan', ['completed']);
    const otherParent = storage.findOrCreateTask({
      title: 'other',
      repo_root: '/other',
      branch: 'spec/other-plan',
      created_by: 'planner',
    });
    void otherParent;
    const otherSub = storage.findOrCreateTask({
      title: 'other-sub',
      repo_root: '/other',
      branch: 'spec/other-plan/sub-0',
      created_by: 'planner',
    });
    storage.insertObservation({
      session_id: 'planner',
      kind: 'plan-subtask-claim',
      content: 'other sub-0 completed',
      compressed: false,
      intensity: null,
      ts: Date.now(),
      task_id: otherSub.id,
      reply_to: null,
      metadata: { kind: 'plan-subtask-claim', status: 'completed' },
    });
    expect(storage.findCompletedQueenPlans('/repo').map((r) => r.plan_slug)).toEqual([
      'repo-a-plan',
    ]);
    expect(storage.findCompletedQueenPlans('/other').map((r) => r.plan_slug)).toEqual([
      'other-plan',
    ]);
    expect(
      storage
        .findCompletedQueenPlans()
        .map((r) => r.plan_slug)
        .sort(),
    ).toEqual(['other-plan', 'repo-a-plan']);
  });
});
