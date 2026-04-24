import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import { PheromoneSystem } from '../src/pheromone.js';
import { TaskThread } from '../src/task-thread.js';

let dir: string;
let store: MemoryStore;

function seedTwoSessionTask(): number {
  store.startSession({ id: 'A', ide: 'claude-code', cwd: '/repo' });
  store.startSession({ id: 'B', ide: 'codex', cwd: '/repo' });
  const thread = TaskThread.open(store, {
    repo_root: '/repo',
    branch: 'feat/pheromone',
    session_id: 'A',
  });
  thread.join('A', 'claude');
  thread.join('B', 'codex');
  return thread.task_id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-pheromone-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
});

afterEach(() => {
  vi.useRealTimers();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('PheromoneSystem.decay', () => {
  it('returns the deposit unchanged at t=deposited_at', () => {
    expect(PheromoneSystem.decay(1, 1_000, 1_000)).toBe(1);
  });

  it('halves the deposit after one half-life', () => {
    const t0 = 1_000_000;
    const halfLife = PheromoneSystem.halfLifeMs;
    const result = PheromoneSystem.decay(1, t0, t0 + halfLife);
    expect(result).toBeCloseTo(0.5, 6);
  });

  it('is clamped against negative elapsed (clock skew)', () => {
    expect(PheromoneSystem.decay(2, 2_000, 1_000)).toBe(2);
  });
});

describe('PheromoneSystem.deposit', () => {
  it('creates a fresh row with the deposit amount when none exists', () => {
    const task_id = seedTwoSessionTask();
    const p = new PheromoneSystem(store.storage);
    p.deposit({ task_id, file_path: 'src/x.ts', session_id: 'A' });
    const row = store.storage.getPheromone(task_id, 'src/x.ts', 'A');
    expect(row?.strength).toBe(PheromoneSystem.depositAmount);
  });

  it('reinforces: second deposit adds to the decayed current value', () => {
    const task_id = seedTwoSessionTask();
    const p = new PheromoneSystem(store.storage);
    const t0 = 1_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    p.deposit({ task_id, file_path: 'src/x.ts', session_id: 'A' });
    // Advance one half-life, then deposit again. Expected: 0.5 (decayed) + 1.0.
    vi.setSystemTime(t0 + PheromoneSystem.halfLifeMs);
    p.deposit({ task_id, file_path: 'src/x.ts', session_id: 'A' });
    const row = store.storage.getPheromone(task_id, 'src/x.ts', 'A');
    expect(row?.strength).toBeCloseTo(1.5, 5);
  });

  it('clamps at MAX_STRENGTH under relentless reinforcement', () => {
    const task_id = seedTwoSessionTask();
    const p = new PheromoneSystem(store.storage);
    // 100 fast deposits at the same timestamp: no decay between them, so
    // every deposit adds 1.0. Must clamp at MAX_STRENGTH.
    for (let i = 0; i < 100; i++) {
      p.deposit({ task_id, file_path: 'src/x.ts', session_id: 'A' });
    }
    const row = store.storage.getPheromone(task_id, 'src/x.ts', 'A');
    expect(row?.strength).toBeLessThanOrEqual(PheromoneSystem.maxStrength);
    expect(row?.strength).toBeGreaterThanOrEqual(PheromoneSystem.maxStrength - 0.001);
  });

  it('keeps per-session pheromones independent on the same file', () => {
    const task_id = seedTwoSessionTask();
    const p = new PheromoneSystem(store.storage);
    p.deposit({ task_id, file_path: 'src/x.ts', session_id: 'A' });
    p.deposit({ task_id, file_path: 'src/x.ts', session_id: 'B' });
    p.deposit({ task_id, file_path: 'src/x.ts', session_id: 'B' });
    const aRow = store.storage.getPheromone(task_id, 'src/x.ts', 'A');
    const bRow = store.storage.getPheromone(task_id, 'src/x.ts', 'B');
    expect(aRow?.strength).toBeCloseTo(1.0, 5);
    // B's two fast deposits add (no decay between them).
    expect(bRow?.strength).toBeCloseTo(2.0, 5);
  });
});

describe('PheromoneSystem.sniff', () => {
  it('returns per-session breakdown and summed total, decayed to now', () => {
    const task_id = seedTwoSessionTask();
    const p = new PheromoneSystem(store.storage);
    const t0 = 1_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    p.deposit({ task_id, file_path: 'src/x.ts', session_id: 'A' });
    p.deposit({ task_id, file_path: 'src/x.ts', session_id: 'B' });
    vi.setSystemTime(t0 + PheromoneSystem.halfLifeMs);
    const out = p.sniff({ task_id, file_path: 'src/x.ts' });
    // Both decayed to 0.5.
    expect(out.total).toBeCloseTo(1.0, 5);
    expect(out.bySession).toHaveLength(2);
    const byId = Object.fromEntries(out.bySession.map((s) => [s.session_id, s.strength]));
    expect(byId.A).toBeCloseTo(0.5, 5);
    expect(byId.B).toBeCloseTo(0.5, 5);
  });

  it('returns empty total and [] when no one has touched the file', () => {
    const task_id = seedTwoSessionTask();
    const p = new PheromoneSystem(store.storage);
    const out = p.sniff({ task_id, file_path: 'untouched.ts' });
    expect(out).toEqual({ total: 0, bySession: [] });
  });
});

describe('PheromoneSystem.strongestTrails', () => {
  it('ranks files by summed current strength and filters below floor', () => {
    const task_id = seedTwoSessionTask();
    const p = new PheromoneSystem(store.storage);
    // hot.ts: three deposits, no decay.
    p.deposit({ task_id, file_path: 'hot.ts', session_id: 'A' });
    p.deposit({ task_id, file_path: 'hot.ts', session_id: 'A' });
    p.deposit({ task_id, file_path: 'hot.ts', session_id: 'B' });
    // warm.ts: one deposit.
    p.deposit({ task_id, file_path: 'warm.ts', session_id: 'A' });
    // stale.ts: one old deposit, far below the noise floor.
    store.storage.upsertPheromone({
      task_id,
      file_path: 'stale.ts',
      session_id: 'A',
      strength: 1.0,
      deposited_at: Date.now() - 10 * PheromoneSystem.halfLifeMs, // ~0.001
    });
    const trails = p.strongestTrails(task_id, 0.1);
    const names = trails.map((t) => t.file_path);
    expect(names).toContain('hot.ts');
    expect(names).toContain('warm.ts');
    expect(names).not.toContain('stale.ts');
    expect(names[0]).toBe('hot.ts'); // highest total
  });
});
