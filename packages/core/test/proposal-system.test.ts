import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import { ProposalSystem } from '../src/proposal-system.js';

let dir: string;
let store: MemoryStore;

function seed(...ids: string[]): void {
  for (const id of ids) {
    store.startSession({ id, ide: 'claude-code', cwd: '/repo' });
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-proposal-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
});

afterEach(() => {
  vi.useRealTimers();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ProposalSystem.propose', () => {
  it('records the proposal and seeds it with a single explicit reinforcement from the proposer', () => {
    seed('A');
    const proposals = new ProposalSystem(store);
    const id = proposals.propose({
      repo_root: '/r',
      branch: 'b',
      summary: 'split search',
      rationale: 'bm25 and semantic are separate concerns',
      touches_files: ['src/core.ts'],
      session_id: 'A',
    });
    const strength = proposals.currentStrength(id);
    expect(strength).toBeCloseTo(ProposalSystem.WEIGHTS.explicit, 5);
  });
});

describe('ProposalSystem.reinforce', () => {
  it('adds reinforcement and reports new strength', () => {
    seed('A', 'B');
    const proposals = new ProposalSystem(store);
    const id = proposals.propose({
      repo_root: '/r',
      branch: 'b',
      summary: 's',
      rationale: 'r',
      touches_files: [],
      session_id: 'A',
    });
    const result = proposals.reinforce({ proposal_id: id, session_id: 'B', kind: 'adjacent' });
    expect(result.strength).toBeCloseTo(
      ProposalSystem.WEIGHTS.explicit + ProposalSystem.WEIGHTS.adjacent,
      5,
    );
    expect(result.promoted).toBe(false);
  });

  it('does not promote when strength is below threshold', () => {
    seed('A', 'B');
    const proposals = new ProposalSystem(store);
    const id = proposals.propose({
      repo_root: '/r',
      branch: 'b',
      summary: 's',
      rationale: 'r',
      touches_files: [],
      session_id: 'A',
    });
    // Add two adjacent reinforcements — total strength ~ 1.0 + 0.3 + 0.3 = 1.6.
    proposals.reinforce({ proposal_id: id, session_id: 'B', kind: 'adjacent' });
    const result = proposals.reinforce({ proposal_id: id, session_id: 'B', kind: 'adjacent' });
    expect(result.promoted).toBe(false);
    const proposal = store.storage.getProposal(id);
    expect(proposal?.status).toBe('pending');
    expect(proposal?.task_id).toBeNull();
  });

  it('promotes to a real task when strength crosses threshold', () => {
    seed('A', 'B', 'C');
    const proposals = new ProposalSystem(store);
    const id = proposals.propose({
      repo_root: '/r',
      branch: 'b',
      summary: 'the real thing',
      rationale: 'three agents all agree',
      touches_files: ['src/x.ts'],
      session_id: 'A',
    });
    // Proposer = 1.0. Two explicit supporters = 2.0. Total 3.0 > 2.5.
    proposals.reinforce({ proposal_id: id, session_id: 'B', kind: 'explicit' });
    const result = proposals.reinforce({ proposal_id: id, session_id: 'C', kind: 'explicit' });
    expect(result.promoted).toBe(true);
    const proposal = store.storage.getProposal(id);
    expect(proposal?.status).toBe('active');
    expect(proposal?.task_id).not.toBeNull();
    expect(proposal?.promoted_at).not.toBeNull();

    // The promoted task should exist on a synthetic branch so it doesn't
    // collide with the source branch's task via the (repo_root, branch)
    // UNIQUE constraint.
    if (!proposal?.task_id) throw new Error('expected promoted task id');
    const task = store.storage.getTask(proposal.task_id);
    expect(task?.branch).toBe(`b/proposal-${id}`);
    expect(task?.title).toBe('the real thing');
  });

  it('is idempotent after promotion: further reinforcements do not re-promote', () => {
    seed('A', 'B', 'C', 'D');
    const proposals = new ProposalSystem(store);
    const id = proposals.propose({
      repo_root: '/r',
      branch: 'b',
      summary: 's',
      rationale: 'r',
      touches_files: [],
      session_id: 'A',
    });
    proposals.reinforce({ proposal_id: id, session_id: 'B', kind: 'explicit' });
    proposals.reinforce({ proposal_id: id, session_id: 'C', kind: 'explicit' });
    const first_task_id = store.storage.getProposal(id)?.task_id;
    expect(first_task_id).not.toBeNull();

    const result = proposals.reinforce({ proposal_id: id, session_id: 'D', kind: 'explicit' });
    expect(result.promoted).toBe(false);
    expect(store.storage.getProposal(id)?.task_id).toBe(first_task_id);
  });
});

describe('ProposalSystem.currentStrength decay', () => {
  it('applies exponential decay per-reinforcement', () => {
    seed('A');
    const proposals = new ProposalSystem(store);
    const t0 = 1_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    const id = proposals.propose({
      repo_root: '/r',
      branch: 'b',
      summary: 's',
      rationale: 'r',
      touches_files: [],
      session_id: 'A',
    });
    // Advance one hour (half-life) and check: original 1.0 deposit should
    // have decayed to ~0.5.
    vi.setSystemTime(t0 + 60 * 60_000);
    expect(proposals.currentStrength(id)).toBeCloseTo(0.5, 2);
  });
});

describe('ProposalSystem.pendingProposalsTouching', () => {
  it('returns ids of pending proposals whose touches_files includes the path', () => {
    seed('A');
    const proposals = new ProposalSystem(store);
    const a = proposals.propose({
      repo_root: '/r',
      branch: 'b',
      summary: 'A',
      rationale: '',
      touches_files: ['src/x.ts', 'src/y.ts'],
      session_id: 'A',
    });
    proposals.propose({
      repo_root: '/r',
      branch: 'b',
      summary: 'B',
      rationale: '',
      touches_files: ['src/z.ts'],
      session_id: 'A',
    });
    expect(
      proposals.pendingProposalsTouching({
        repo_root: '/r',
        branch: 'b',
        file_path: 'src/x.ts',
      }),
    ).toEqual([a]);
    expect(
      proposals.pendingProposalsTouching({
        repo_root: '/r',
        branch: 'b',
        file_path: 'src/nothing.ts',
      }),
    ).toEqual([]);
  });

  it('excludes proposals that have already been promoted', () => {
    seed('A', 'B', 'C');
    const proposals = new ProposalSystem(store);
    const id = proposals.propose({
      repo_root: '/r',
      branch: 'b',
      summary: 's',
      rationale: '',
      touches_files: ['src/x.ts'],
      session_id: 'A',
    });
    proposals.reinforce({ proposal_id: id, session_id: 'B', kind: 'explicit' });
    proposals.reinforce({ proposal_id: id, session_id: 'C', kind: 'explicit' });
    // Promoted; should not reappear in adjacency matches.
    expect(
      proposals.pendingProposalsTouching({
        repo_root: '/r',
        branch: 'b',
        file_path: 'src/x.ts',
      }),
    ).toEqual([]);
  });
});

describe('ProposalSystem.foragingReport', () => {
  it('ranks pending by strength desc, lists promoted separately, and omits evaporated proposals', () => {
    seed('A', 'B', 'C');
    const proposals = new ProposalSystem(store);
    const strong = proposals.propose({
      repo_root: '/r',
      branch: 'b',
      summary: 'strong',
      rationale: '',
      touches_files: [],
      session_id: 'A',
    });
    proposals.reinforce({ proposal_id: strong, session_id: 'B', kind: 'explicit' });
    // Weak proposal: proposer only, strength ~1.0.
    proposals.propose({
      repo_root: '/r',
      branch: 'b',
      summary: 'weak',
      rationale: '',
      touches_files: [],
      session_id: 'A',
    });
    // Promoted proposal.
    const promoted = proposals.propose({
      repo_root: '/r',
      branch: 'b',
      summary: 'promoted',
      rationale: '',
      touches_files: [],
      session_id: 'A',
    });
    proposals.reinforce({ proposal_id: promoted, session_id: 'B', kind: 'explicit' });
    proposals.reinforce({ proposal_id: promoted, session_id: 'C', kind: 'explicit' });

    const report = proposals.foragingReport('/r', 'b');
    expect(report.pending.map((p) => p.summary)).toEqual(['strong', 'weak']);
    expect(report.pending[0].strength).toBeGreaterThan(report.pending[1].strength);
    expect(report.promoted.map((p) => p.summary)).toEqual(['promoted']);
    // The promoted one must expose its task_id.
    expect(report.promoted[0].task_id).toBeGreaterThan(0);
    expect(report.pending.find((p) => p.id === promoted)).toBeUndefined();
    expect(report.pending.find((p) => p.id === strong)?.reinforcement_count).toBe(2);
  });

  it('filters proposals whose strength has evaporated below NOISE_FLOOR', () => {
    seed('A');
    const proposals = new ProposalSystem(store);
    const id = proposals.propose({
      repo_root: '/r',
      branch: 'b',
      summary: 'ancient',
      rationale: '',
      touches_files: [],
      session_id: 'A',
    });
    // Force the reinforcement timestamp to the distant past by rewriting it
    // directly; can't use vi.setSystemTime here because the insert already
    // happened and we need to make that insert's age big.
    const veryOld = Date.now() - 10 * 60 * 60_000; // 10 hours ago -> way below floor
    (
      store.storage as unknown as {
        db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } };
      }
    ).db
      .prepare('UPDATE proposal_reinforcements SET reinforced_at = ? WHERE proposal_id = ?')
      .run(veryOld, id);

    const report = proposals.foragingReport('/r', 'b');
    expect(report.pending.find((p) => p.id === id)).toBeUndefined();
  });
});
