import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import { listPlans } from '../src/plan.js';
import { ProposalSystem } from '../src/proposal-system.js';

let dir: string;
let store: MemoryStore;

function seed(...sessions: Array<string | [id: string, ide: string]>): void {
  for (const session of sessions) {
    const [id, ide] = Array.isArray(session) ? session : [session, 'claude-code'];
    store.startSession({ id, ide, cwd: '/repo' });
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
    seed('A', ['B', 'codex']);
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
    // Repeated adjacent support from the same session stays one source:
    // proposer 1.0 + same-agent adjacent 0.3 * 0.6 = 1.18.
    proposals.reinforce({ proposal_id: id, session_id: 'B', kind: 'adjacent' });
    const result = proposals.reinforce({ proposal_id: id, session_id: 'B', kind: 'adjacent' });
    expect(result.promoted).toBe(false);
    const proposal = store.storage.getProposal(id);
    expect(proposal?.status).toBe('pending');
    expect(proposal?.task_id).toBeNull();
  });

  it('promotes to a real task when strength crosses threshold', () => {
    seed('A', 'B', ['C', 'codex']);
    const proposals = new ProposalSystem(store);
    const id = proposals.propose({
      repo_root: '/r',
      branch: 'b',
      summary: 'the real thing',
      rationale: 'three agents all agree',
      touches_files: ['src/x.ts'],
      session_id: 'A',
    });
    // Proposer = 1.0. Same-agent supporter = 0.6. Different-agent supporter = 1.0.
    // Total 2.6 > 2.5.
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
    seed('A', 'B', ['C', 'codex'], ['D', 'gemini']);
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

  it('does not inflate strength from repeated same-session reinforcement', () => {
    seed('A', ['B', 'codex']);
    const proposals = new ProposalSystem(store);
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const id = proposals.propose({
      repo_root: '/r',
      branch: 'b',
      summary: 's',
      rationale: 'r',
      touches_files: [],
      session_id: 'A',
    });

    vi.setSystemTime(1_000_001);
    const first = proposals.reinforce({ proposal_id: id, session_id: 'B', kind: 'explicit' });
    for (let i = 2; i <= 6; i += 1) {
      vi.setSystemTime(1_000_000 + i);
      proposals.reinforce({ proposal_id: id, session_id: 'B', kind: 'explicit' });
    }
    const afterSpam = proposals.currentStrength(id);
    const rows = store.storage.listReinforcements(id);
    const report = proposals.foragingReport('/r', 'b');

    expect(afterSpam).toBeCloseTo(first.strength, 4);
    expect(rows.filter((row) => row.session_id === 'B')).toHaveLength(1);
    expect(report.pending.find((proposal) => proposal.id === id)?.reinforcement_count).toBe(2);
  });

  it('adds moderate strength from different sessions of the same agent type', () => {
    seed('A', 'B', 'C');
    const proposals = new ProposalSystem(store);
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const id = proposals.propose({
      repo_root: '/r',
      branch: 'b',
      summary: 's',
      rationale: 'r',
      touches_files: [],
      session_id: 'A',
    });

    const afterB = proposals.reinforce({ proposal_id: id, session_id: 'B', kind: 'explicit' });
    const afterC = proposals.reinforce({ proposal_id: id, session_id: 'C', kind: 'explicit' });

    expect(afterB.strength).toBeCloseTo(
      ProposalSystem.WEIGHTS.explicit +
        ProposalSystem.WEIGHTS.explicit * ProposalSystem.DIVERSITY.sameAgentTypeDifferentSession,
      5,
    );
    expect(afterC.strength).toBeGreaterThan(afterB.strength);
    expect(afterC.strength - afterB.strength).toBeCloseTo(
      ProposalSystem.WEIGHTS.explicit * ProposalSystem.DIVERSITY.sameAgentTypeDifferentSession,
      5,
    );
  });

  it('gives rediscovery from a different agent type a stronger bonus than explicit support', () => {
    seed('A', ['B', 'codex']);
    const proposals = new ProposalSystem(store);
    const explicit = proposals.propose({
      repo_root: '/r',
      branch: 'b',
      summary: 'explicit',
      rationale: 'r',
      touches_files: [],
      session_id: 'A',
    });
    const rediscovered = proposals.propose({
      repo_root: '/r',
      branch: 'b',
      summary: 'rediscovered',
      rationale: 'r',
      touches_files: [],
      session_id: 'A',
    });

    const explicitResult = proposals.reinforce({
      proposal_id: explicit,
      session_id: 'B',
      kind: 'explicit',
    });
    const rediscoveredResult = proposals.reinforce({
      proposal_id: rediscovered,
      session_id: 'B',
      kind: 'rediscovered',
    });

    expect(rediscoveredResult.strength).toBeGreaterThan(explicitResult.strength);
    expect(rediscoveredResult.strength - explicitResult.strength).toBeCloseTo(
      ProposalSystem.WEIGHTS.rediscovered - ProposalSystem.WEIGHTS.explicit,
      5,
    );
  });

  it('promotes when source-diverse rediscovery crosses the threshold', () => {
    seed('A', 'B', ['C', 'codex']);
    const proposals = new ProposalSystem(store);
    const id = proposals.propose({
      repo_root: '/r',
      branch: 'b',
      summary: 'converged work',
      rationale: 'same food source found independently',
      touches_files: [],
      session_id: 'A',
    });

    proposals.reinforce({ proposal_id: id, session_id: 'B', kind: 'explicit' });
    const result = proposals.reinforce({ proposal_id: id, session_id: 'C', kind: 'rediscovered' });

    expect(result.strength).toBeGreaterThanOrEqual(ProposalSystem.PROMOTION_THRESHOLD);
    expect(result.promoted).toBe(true);
    expect(store.storage.getProposal(id)?.status).toBe('active');
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
    seed('A', 'B', ['C', 'codex']);
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
    seed('A', ['B', 'codex'], ['C', 'gemini']);
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
    expect(report.pending.find((p) => p.id === strong)?.signal_metadata).toMatchObject({
      signal_kind: 'proposal',
      source_session_id: 'A',
      half_life_minutes: 60,
      reinforced_by_sessions: ['A', 'B'],
    });
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

describe('ProposalSystem promotion-to-plan bridge', () => {
  it('synthesizes a lite plan when a proposal with touches_files crosses threshold', () => {
    seed('A', 'B', ['C', 'codex']);
    const proposals = new ProposalSystem(store);
    const id = proposals.propose({
      repo_root: '/r',
      branch: 'b',
      summary: 'colony foraging cleanup',
      rationale: 'three agents agree this needs attention',
      touches_files: ['packages/core/src/foraging.ts', 'packages/core/src/proposal-system.ts'],
      session_id: 'A',
    });
    proposals.reinforce({ proposal_id: id, session_id: 'B', kind: 'explicit' });
    const result = proposals.reinforce({ proposal_id: id, session_id: 'C', kind: 'explicit' });
    expect(result.promoted).toBe(true);

    // listPlans must surface the synthesized plan with one sub-task per
    // file in touches_files.
    const plans = listPlans(store, { repo_root: '/r' });
    const promoted = plans.find((p) => p.plan_slug === `proposal-${id}`);
    expect(promoted).toBeDefined();
    if (!promoted) return;
    expect(promoted.title).toBe('colony foraging cleanup');
    expect(promoted.subtasks).toHaveLength(2);
    expect(promoted.subtasks.map((s) => s.subtask_index)).toEqual([0, 1]);
    expect(promoted.subtask_counts.available).toBe(2);
    expect(promoted.subtasks[0]?.file_scope).toEqual(['packages/core/src/foraging.ts']);
    expect(promoted.subtasks[1]?.file_scope).toEqual(['packages/core/src/proposal-system.ts']);
  });

  it('stamps a proposal-promoted observation on the synthesized plan root', () => {
    seed('A', 'B', ['C', 'codex']);
    const proposals = new ProposalSystem(store);
    const id = proposals.propose({
      repo_root: '/r',
      branch: 'b',
      summary: 'pheromone overlap',
      rationale: 'r',
      touches_files: ['src/x.ts'],
      session_id: 'A',
    });
    proposals.reinforce({ proposal_id: id, session_id: 'B', kind: 'explicit' });
    proposals.reinforce({ proposal_id: id, session_id: 'C', kind: 'explicit' });

    const plans = listPlans(store, { repo_root: '/r' });
    const promoted = plans.find((p) => p.plan_slug === `proposal-${id}`);
    expect(promoted).toBeDefined();
    if (!promoted) return;

    const events = store.storage.taskObservationsByKind(
      promoted.spec_task_id,
      'proposal-promoted',
      10,
    );
    expect(events).toHaveLength(1);
    const meta = JSON.parse(events[0]?.metadata ?? '{}');
    expect(meta.plan_slug).toBe(`proposal-${id}`);
    expect(meta.promoted_from_proposal_id).toBe(id);
    expect(meta.subtask_count).toBe(1);
  });

  it('skips plan synthesis when touches_files is empty (TaskThread still opens)', () => {
    seed('A', 'B', ['C', 'codex']);
    const proposals = new ProposalSystem(store);
    const id = proposals.propose({
      repo_root: '/r',
      branch: 'b',
      summary: 'pure-prose proposal',
      rationale: 'r',
      touches_files: [],
      session_id: 'A',
    });
    proposals.reinforce({ proposal_id: id, session_id: 'B', kind: 'explicit' });
    const result = proposals.reinforce({ proposal_id: id, session_id: 'C', kind: 'explicit' });
    expect(result.promoted).toBe(true);

    // Promotion proceeded — task thread exists on the synthetic branch.
    const proposal = store.storage.getProposal(id);
    expect(proposal?.status).toBe('active');
    expect(proposal?.task_id).not.toBeNull();

    // …but no plan was synthesized because touches_files was empty.
    const plans = listPlans(store, { repo_root: '/r' });
    expect(plans.find((p) => p.plan_slug === `proposal-${id}`)).toBeUndefined();
  });

  it('is idempotent: the synthesized plan is created exactly once per proposal', () => {
    seed('A', 'B', ['C', 'codex'], ['D', 'gemini']);
    const proposals = new ProposalSystem(store);
    const id = proposals.propose({
      repo_root: '/r',
      branch: 'b',
      summary: 's',
      rationale: 'r',
      touches_files: ['src/x.ts'],
      session_id: 'A',
    });
    proposals.reinforce({ proposal_id: id, session_id: 'B', kind: 'explicit' });
    proposals.reinforce({ proposal_id: id, session_id: 'C', kind: 'explicit' });

    // Crossing-threshold reinforcement #1: synthesize plan.
    let plans = listPlans(store, { repo_root: '/r' });
    const planAfterFirst = plans.find((p) => p.plan_slug === `proposal-${id}`);
    expect(planAfterFirst).toBeDefined();
    const firstSpecTaskId = planAfterFirst?.spec_task_id;

    // Re-reinforce after promotion. maybePromote short-circuits at the
    // status guard before reaching synthesizePlanFromProposal again, so
    // no duplicate plan is created and no extra sub-tasks appear.
    proposals.reinforce({ proposal_id: id, session_id: 'D', kind: 'explicit' });

    plans = listPlans(store, { repo_root: '/r' });
    const planAfterSecond = plans.find((p) => p.plan_slug === `proposal-${id}`);
    expect(planAfterSecond?.spec_task_id).toBe(firstSpecTaskId);
    expect(planAfterSecond?.subtasks).toHaveLength(1);
  });

  it('caps synthesized sub-tasks at the explicit-publish maximum (20)', () => {
    seed('A', 'B', ['C', 'codex']);
    const proposals = new ProposalSystem(store);
    // 25 files — should clamp to 20 sub-tasks to match task_plan_publish.
    const files = Array.from({ length: 25 }, (_, i) => `src/file-${i}.ts`);
    const id = proposals.propose({
      repo_root: '/r',
      branch: 'b',
      summary: 'wide refactor',
      rationale: 'r',
      touches_files: files,
      session_id: 'A',
    });
    proposals.reinforce({ proposal_id: id, session_id: 'B', kind: 'explicit' });
    proposals.reinforce({ proposal_id: id, session_id: 'C', kind: 'explicit' });

    const plans = listPlans(store, { repo_root: '/r' });
    const promoted = plans.find((p) => p.plan_slug === `proposal-${id}`);
    expect(promoted?.subtasks).toHaveLength(20);
  });
});
